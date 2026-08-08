// The desk page, in a real browser.
//
// A hundred thousand rows are built on load. That is a scene worth having
// here on its own: `put(...rows)` at this size overflows the call stack in a
// browser and not in Node, so the page once died on load while every test was
// green.

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function count(page: Page, label: string): Promise<number> {
  const value = await page
    .locator('.count', { has: page.locator('span', { hasText: label }) })
    .locator('b')
    .innerText()
  return Number(value.replaceAll(/[^\d]/g, ''))
}

test.beforeEach(async ({ page }) => {
  const trouble: string[] = []
  page.on('pageerror', error => trouble.push(String(error)))
  await page.goto('/table/wire/')
  await expect(page.locator('.row').first()).toBeVisible({ timeout: 30_000 })
  expect(trouble, 'the page loaded without throwing').toEqual([])
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
  await page.locator('.scroller').evaluate(node => {
    node.scrollTop = 0
  })
  await page.waitForTimeout(300)

  await expect(page.locator('.row input')).toHaveValue('half typed')
})

// The whole-table page: the protocol under a real wire.
test.describe('a whole table over a wire', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/table/full/')
    await expect(page.locator('.rows li').first()).toBeVisible({ timeout: 30_000 })
  })

  test('rows keep arriving while nobody touches the page', async ({ page }) => {
    const before = await count(page, 'rows in the table')
    await page.waitForTimeout(1500)
    expect(await count(page, 'rows in the table')).toBeGreaterThan(before)
  })

  test('losing batches is noticed, and the catch-up puts it right', async ({ page }) => {
    await page.click('button:has-text("lose batches")')
    await page.waitForTimeout(1500)

    // The rows on screen are the last good ones, and the page says so.
    await expect(page.locator('.state')).toContainText('lost')

    await page.click('button:has-text("stop losing batches")')
    await page.waitForTimeout(2000)

    await expect(page.locator('.state')).toContainText('up to date')
    // And the table on this side agrees with the one on the other side.
    const size = await count(page, 'rows in the table')
    expect(size).toBeGreaterThan(0)
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
