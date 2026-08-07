// The engine page, in a real browser with a real worker.
//
// Everything here is a thing Node cannot show: message ordering between
// threads, a worker that is genuinely busy, a tab that goes to the background.
// The checks read the numbers the page already puts on screen — started,
// finished, called off — because those are the numbers a person would look at.

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/** One of the counters under the search box, by its label. */
async function count(page: Page, label: string): Promise<number> {
  const value = await page
    .locator('.count', { has: page.locator('span', { hasText: label }) })
    .locator('b')
    .innerText()
  return Number(value.replaceAll(/[^\d]/g, ''))
}

/** Wait until the corpus is built and the first answer is on screen. */
async function ready(page: Page): Promise<void> {
  await page.fill('.search input', 'payment')
  await expect(page.locator('.summary')).toContainText('matches', { timeout: 60_000 })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/engine/')
})

test('typing faster than the search calls the running one off', async ({ page }) => {
  await ready(page)
  const before = await count(page, 'runs called off')

  // Three letters, faster than a search over four million lines. In Node this
  // works whatever the yield does; in a browser it only works if the worker
  // is given a chance to hear the new question.
  await page.type('.search input', 'xyz', { delay: 60 })
  await page.waitForTimeout(2000)

  expect(await count(page, 'runs called off')).toBeGreaterThan(before)
})

test('every run is accounted for: started = finished + called off', async ({ page }) => {
  await ready(page)
  await page.type('.search input', 'abc', { delay: 80 })
  await page.waitForTimeout(4000)

  const started = await count(page, 'runs started')
  const finished = await count(page, 'runs finished')
  const calledOff = await count(page, 'runs called off')
  expect(started).toBe(finished + calledOff)
})

test('the box does not stutter while the worker searches', async ({ page }) => {
  await ready(page)

  // Typing latency with a search running: if the searching were happening on
  // this thread, keystrokes would queue behind it.
  const worst = await page.evaluate(async () => {
    const box = document.querySelector('.search input') as HTMLInputElement
    let worstGap = 0
    for (let i = 0; i < 20; i++) {
      const started = performance.now()
      box.value += 'a'
      box.dispatchEvent(new Event('input', { bubbles: true }))
      // Waiting for a frame per keystroke is the measurement: how long the
      // page took to come back after the typing.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
      worstGap = Math.max(worstGap, performance.now() - started)
    }
    return worstGap
  })

  expect(worst).toBeLessThan(120)
})

test('hiding the results stops the work, showing them starts it again', async ({ page }) => {
  await ready(page)
  await page.waitForTimeout(2000)

  await page.click('button:has-text("hide results")')
  await page.waitForTimeout(500)
  const whileHidden = await count(page, 'chunks published')
  await page.waitForTimeout(2000)
  expect(await count(page, 'chunks published')).toBe(whileHidden)

  await page.click('button:has-text("show results")')
  await page.fill('.search input', 'declined')
  await page.waitForTimeout(2000)
  expect(await count(page, 'chunks published')).toBeGreaterThan(whileHidden)
})

test('killing the worker loses nothing', async ({ page }) => {
  await ready(page)
  await page.waitForTimeout(2000)
  const shown = await page.locator('.summary').innerText()

  await page.click('button:has-text("kill the worker")')
  // A new worker comes up empty: it rebuilds the corpus and answers the same
  // question again, without a line of reconnect code on the page.
  await expect(page.locator('.summary')).toContainText('matches', { timeout: 60_000 })
  await page.waitForTimeout(1000)

  expect(await page.locator('.summary').innerText()).toContain(shown.split(' matches')[0] ?? '')
  expect(await count(page, 'runs started')).toBeGreaterThan(0)
})

test('a backgrounded tab keeps serving its panels', async ({ page, context }) => {
  await ready(page)
  await page.waitForTimeout(1500)
  const before = await count(page, 'packets on the wire')

  // Frames stop in a hidden tab; the wire has a timer racing the frame for
  // exactly this reason.
  const other = await context.newPage()
  await other.goto('about:blank')
  await other.bringToFront()

  await page.fill('.search input', 'session')
  await page.waitForTimeout(3000)
  await page.bringToFront()

  expect(await count(page, 'packets on the wire')).toBeGreaterThan(before)
})
