import { expect, test } from '@playwright/test';
import { expectCell, goTo, signUp, typeInto, watchNumber } from './helpers';

test('sign up, edit cells, formulas spill and recalculate', async ({ page }) => {
  await signUp(page, 'Ada');
  await page.getByTestId('new-blank').click();
  await expect(page.getByTestId('status')).toHaveText(/live/);
  await typeInto(page, 'A1', '3');
  await typeInto(page, 'A2', '4');
  await typeInto(page, 'B1', '=SUM(A1:A2)*10');
  await expectCell(page, 'B1', '70');
  await typeInto(page, 'C1', '=SEQUENCE(3,1,A1,A2)');
  await expectCell(page, 'C3', '11');
  await typeInto(page, 'A1', '5');
  await expectCell(page, 'B1', '90');
  await expectCell(page, 'C3', '13');
  await typeInto(page, 'D1', '=1/0');
  await expectCell(page, 'D1', '#DIV/0!');

  // Autocomplete and signature help in the formula editor.
  await goTo(page, 'E1');
  await page.keyboard.type('=XLOO');
  await expect(page.getByRole('option', { name: /XLOOKUP/ })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('signature-help')).toContainText('lookup_value');
  await page.keyboard.press('Escape');

  // Undo walks back through our own edits: first D1, then A1 = 5.
  await goTo(page, 'A1');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expectCell(page, 'B1', '70');
  await expectCell(page, 'D1', '');
  await page.keyboard.press('Control+y');
  await expectCell(page, 'B1', '90');
});

test('fill handle extends number series and moves relative references', async ({ page }) => {
  await signUp(page, 'Filler');
  await page.getByTestId('new-blank').click();
  await expect(page.getByTestId('status')).toHaveText(/live/);
  await typeInto(page, 'F1', '1');
  await typeInto(page, 'F2', '2');
  await typeInto(page, 'G1', '=F1*10');
  // Select F1:G2, then drag the corner handle (bottom-right of G2) down to row 5.
  const grid = (await page.getByTestId('grid').boundingBox())!;
  const at = (col: number, row: number) => ({ x: grid.x + 58 + col * 92, y: grid.y + 24 + row * 22 });
  await page.mouse.click(at(5, 0).x + 10, at(5, 0).y + 10);
  await page.keyboard.down('Shift');
  await page.mouse.click(at(6, 1).x + 10, at(6, 1).y + 10);
  await page.keyboard.up('Shift');
  const corner = at(7, 2);
  await page.mouse.move(corner.x - 1, corner.y - 1);
  await page.mouse.down();
  await page.mouse.move(corner.x - 1, at(7, 5).y - 5, { steps: 5 });
  await page.mouse.up();
  await expectCell(page, 'F5', '5');
  // G1:G2 is (formula, blank), so the pattern repeats with the reference moved, as in Excel.
  await expectCell(page, 'G3', '30');
  await expectCell(page, 'G4', '');
  await expectCell(page, 'G5', '50');
});

test('two users collaborate live through a share link', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await signUp(alice, 'Alice');
  await alice.getByTestId('new-blank').click();
  await expect(alice.getByTestId('status')).toHaveText(/live/);
  await alice.getByTestId('share').click();
  const link = await alice.getByTestId('share-editor').inputValue();
  await alice.keyboard.press('Escape');
  await alice.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });

  await signUp(bob, 'Bob');
  await bob.goto(link);
  await expect(bob.getByTestId('status')).toHaveText(/live/);
  await expect(alice.locator('[data-testid=peers] .avatar')).toHaveCount(2);

  await typeInto(alice, 'B2', '41');
  await typeInto(bob, 'B3', '=B2+1');
  await expectCell(alice, 'B3', '42');
  await expectCell(bob, 'B2', '41');
  await typeInto(alice, 'B2', '99');
  await expectCell(bob, 'B3', '100');
});

test('the neural-net workbook trains by iterative calculation and the loss drops', async ({ page }) => {
  await signUp(page, 'Trainer');
  await page.getByTestId('new-neural-net').click();
  await expect(page.getByTestId('watch-Step')).toContainText('0');
  const initialLoss = watchNumber(await page.getByTestId('watch-Loss').textContent());
  expect(initialLoss).toBeGreaterThan(0.5);
  await page.getByTestId('play').click();
  await expect
    .poll(async () => watchNumber(await page.getByTestId('watch-Step').textContent()), { timeout: 30_000 })
    .toBeGreaterThan(400);
  await page.getByTestId('play').click();
  // Pausing commits the iteration state; give it a moment to become a version.
  await page.waitForTimeout(1500);
  const loss = watchNumber(await page.getByTestId('watch-Loss').textContent());
  expect(loss).toBeLessThan(initialLoss / 4);
  await expect(page.getByTestId('watch-Accuracy')).toContainText(/9\d\.\d%|100\.0%/);

  // Version history: the timeline can rewind to the untrained network.
  await page.getByTestId('history').click();
  await page.getByTestId('timeline-slider').fill('0');
  await expect(page.getByTestId('preview-banner')).toContainText('Viewing version 0');
  await expect.poll(async () => watchNumber(await page.getByTestId('watch-Step').textContent())).toBe(0);

  // Reset pulses the Reset flag for one iteration: back to step 0.
  await page.getByText('Back to live').click();
  await page.getByTestId('action-reset').click();
  await expect.poll(async () => watchNumber(await page.getByTestId('watch-Step').textContent())).toBe(0);
});

test('the transformer workbook predicts and generates characters', async ({ page }) => {
  await signUp(page, 'Gen');
  await page.getByTestId('new-transformer').click();
  await expect(page.getByTestId('watch-Prompt')).toContainText('em');
  const next = (await page.getByTestId('watch-NextChar').textContent())!.replace('NextChar', '').trim();
  expect(next).toMatch(/^[a-z.]$/);
  await page.getByTestId('action-generate').click();
  await expect(page.getByTestId('watch-Prompt')).toContainText(`em${next}`);
});
