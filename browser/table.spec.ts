// The desk pages, in a real browser.
//
// A hundred thousand rows are built on load. That is a scene worth having
// here on its own: `put(...rows)` at this size overflows the call stack in a
// browser and not in Node, so the page once died on load while every test was
// green.

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function count(page: Page, label: string): Promise<number> {
  const shown = page
    .locator('.count', { has: page.locator('span', { hasText: label }) })
    .locator('b')
  // Waited for on purpose, and with an end to the waiting: `innerText` on a
  // missing element waits for ever, so a page that died halfway through used
  // up the whole test timeout and reported nothing but the timeout.
  await expect(shown, `the page shows "${label}"`).toBeVisible({ timeout: 15_000 })
  return Number((await shown.innerText()).replaceAll(/[^\d]/g, ''))
}

/**
 * Whatever the page threw, for the whole test rather than for the load.
 *
 * A screen that dies halfway through looks exactly like a screen that lost a
 * value: the element the assertion wants is missing either way. Watching for
 * the whole test is what tells the two apart, and it costs a listener.
 */
function trouble(page: Page): string[] {
  const said: string[] = []
  page.on('pageerror', error => said.push(String(error)))
  return said
}

test.describe('a window onto a table in another thread', () => {
  let said: string[] = []

  test.beforeEach(async ({ page }) => {
    said = trouble(page)
    await page.goto('/table/wire/')
    await expect(page.locator('.row').first()).toBeVisible({ timeout: 30_000 })
    expect(said, 'the page loaded without throwing').toEqual([])
  })

  test('a table of a hundred thousand rows loads and shows a screenful', async ({ page }) => {
    expect(await count(page, 'rows in the table')).toBe(100_000)
    const shown = await page.locator('.row').count()
    expect(shown).toBeGreaterThan(5)
    expect(shown).toBeLessThan(60)
  })

  test('scrolling costs a screenful, not a table', async ({ page }) => {
    const before = await count(page, 'rows that crossed the wire')

    await page.locator('.scroller').evaluate(node => {
      node.scrollTop = 20_000
    })
    await page.waitForTimeout(500)

    const crossed = (await count(page, 'rows that crossed the wire')) - before
    expect(crossed).toBeGreaterThan(0)
    expect(crossed).toBeLessThan(2_000)
  })

  test('a half-typed edit survives its row scrolling away', async ({ page }) => {
    await page.locator('.row .title').first().click()
    await page.locator('.row input').fill('half typed')

    await page.locator('.scroller').evaluate(node => {
      node.scrollTop = 30_000
    })
    await page.waitForTimeout(300)
    // Stated separately from the draft: a window that came back empty and a
    // draft that was lost are different faults, and the failure should say
    // which one happened rather than leaving it to be guessed.
    await expect(page.locator('.row').first()).toBeVisible()
    expect(said, 'nothing threw while scrolling away').toEqual([])

    await page.locator('.scroller').evaluate(node => {
      node.scrollTop = 0
    })
    await page.waitForTimeout(300)
    await expect(page.locator('.row').first()).toBeVisible()
    expect(said, 'nothing threw while scrolling back').toEqual([])
    // Where the scroller actually is, before what it shows. The browser undoes
    // a jump of its own accord when scroll anchoring is left on, and then the
    // rows are right about a position nobody asked for — a different fault
    // from the window failing to follow.
    expect(
      await page.locator('.scroller').evaluate(node => node.scrollTop),
      'the scroller stayed where it was put',
    ).toBe(0)
    expect(await page.locator('.row .no').first().innerText(), 'the top row is back').toBe('0')

    await expect(page.locator('.row input')).toHaveValue('half typed')
  })
})

// The whole-table page: the protocol under a real wire.
test.describe('a whole table over a wire', () => {
  let said: string[] = []

  test.beforeEach(async ({ page }) => {
    said = trouble(page)
    await page.goto('/table/full/')
    await expect(page.locator('.jobs li').first()).toBeVisible({ timeout: 30_000 })
    expect(said, 'the page loaded without throwing').toEqual([])
  })

  test.afterEach(() => {
    expect(said, 'the page ran without throwing').toEqual([])
  })

  test('rows keep arriving while nobody touches the page', async ({ page }) => {
    const before = await count(page, 'rows in the table')
    await page.waitForTimeout(1500)
    expect(await count(page, 'rows in the table')).toBeGreaterThan(before)
  })

  test('losing batches is noticed, and the catch-up puts it right', async ({ page }) => {
    const caughtUpBefore = await count(page, 'catch-ups')

    await page.click('button:has-text("lose batches")')
    await page.waitForTimeout(1500)

    // While the switch is on nothing of the table crosses, so there is nothing
    // for this side to notice yet: what arrives stops arriving. The gap is
    // found afterwards, not during.
    //
    // Counted by what actually landed here, not by the size of the table. The
    // size is a cell of the other side and cells travel by their own kind of
    // message, which the switch does not touch: the number on screen keeps
    // climbing while not a single row is crossing.
    const frozen = await count(page, 'rows and changes received')
    await page.waitForTimeout(1000)
    expect(
      await count(page, 'rows and changes received'),
      'nothing crossed while the switch was on',
    ).toBe(frozen)

    await page.click('button:has-text("stop losing batches")')
    await page.waitForTimeout(2000)

    // The first batch to arrive after the gap does not fit onto what this side
    // holds; that is the moment the loss is noticed and a catch-up is asked
    // for. The label saying so is up for a round trip, so what is checked is
    // the count of catch-ups rather than the sight of it.
    expect(await count(page, 'catch-ups'), 'the gap was noticed').toBeGreaterThan(caughtUpBefore)
    await expect(page.locator('.state')).toContainText('up to date')
    expect(
      await count(page, 'rows and changes received'),
      'and rows are crossing again',
    ).toBeGreaterThan(frozen)
  })

  test('what crosses is changes, not the table', async ({ page }) => {
    const size = await count(page, 'rows in the table')
    const before = await count(page, 'rows and changes received')

    await page.click('button:has-text("edit 200 rows")')
    await page.waitForTimeout(1000)

    const crossed = (await count(page, 'rows and changes received')) - before
    expect(crossed).toBeLessThan(size)
  })
})
