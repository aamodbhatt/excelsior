import { type Page, expect } from '@playwright/test';

let counter = 0;

/** Signs up a fresh user and lands on the workbook list. */
export async function signUp(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.fill('input[name=name]', name);
  await page.fill('input[name=email]', `${name.toLowerCase()}-${Date.now()}-${counter++}@example.com`);
  await page.fill('input[name=password]', 'password123');
  await page.click('button[type=submit]');
  await expect(page.getByTestId('new-blank')).toBeVisible();
}

/** Moves the selection with the name box, like a user typing an address. */
export async function goTo(page: Page, address: string): Promise<void> {
  await page.getByTestId('namebox').click();
  await page.getByTestId('namebox').fill(address);
  await page.getByTestId('namebox').press('Enter');
}

/** Types into the active cell and commits with Enter. */
export async function typeInto(page: Page, address: string, text: string): Promise<void> {
  await goTo(page, address);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** The status bar shows "A1 = value" for a single selected cell. */
export async function expectCell(page: Page, address: string, value: string): Promise<void> {
  await goTo(page, address);
  await expect(page.getByTestId('cell-value')).toHaveText(`${address} = ${value}`);
}

export function watchNumber(text: string | null): number {
  return Number((text ?? '').replace(/[^0-9.-]/g, ''));
}
