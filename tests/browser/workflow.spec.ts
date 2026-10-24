import { test, expect, chromium } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";
test("mobile workflow: issue JPG, decode QR, concurrent scan, supervisor re-entry, cancel and languages", async ({
  browser,
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("Email address").fill("admin@example.com");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-only-password");
  await page.getByRole("button", { name: "Staff sign in" }).click();
  await expect(
    page.getByRole("button", { name: "Create event" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create event" }).first().click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Event name").fill("Spring Gathering");
  await modal.getByLabel("Date & time").fill("2027-04-01T18:00");
  await modal.getByLabel("Venue", { exact: true }).fill("Community Hall");
  await modal.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Tickets", exact: true }).click();
  await page.getByRole("button", { name: "Issue ticket" }).click();
  await modal.getByLabel("Full name").fill("山田 Linh 王");
  await modal.getByLabel("Email address").fill("guest@example.com");
  await modal.getByLabel("Ticket type").selectOption("performer");
  await modal
    .getByRole("button", { name: "Issue ticket", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
  const jpg = await page
    .getByRole("dialog")
    .getByRole("img")
    .getAttribute("src");
  expect(jpg?.startsWith("data:image/jpeg;base64,")).toBe(true);
  const pixels = await page.evaluate(async (src) => {
    const image = new Image();
    image.src = src!;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const gray = [];
    for (let i = 0; i < rgba.length; i += 4)
      gray.push((rgba[i] + 2 * rgba[i + 1] + rgba[i + 2]) / 4);
    return { gray, width: canvas.width, height: canvas.height };
  }, jpg);
  const decoded = new QRCodeReader()
    .decode(
      new BinaryBitmap(
        new HybridBinarizer(
          new RGBLuminanceSource(
            new Uint8ClampedArray(pixels.gray),
            pixels.width,
            pixels.height,
          ),
        ),
      ),
    )
    .getText();
  expect(decoded).toMatch(/^EG1:/);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download JPG" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.jpg$/);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const eventId = await page
    .getByRole("combobox", { name: "Event", exact: true })
    .inputValue();
  // Actual independent authenticated phone sessions, not mocked requests.
  const staff = await browser.newContext({
    baseURL: "http://localhost:3100",
    viewport: { width: 390, height: 844 },
  });
  const staffPage = await staff.newPage();
  await staffPage.goto("/");
  await staffPage.getByLabel("Email address").fill("checkin@example.com");
  await staffPage
    .getByLabel("Password", { exact: true })
    .fill("browser-test-only-password");
  await staffPage.getByRole("button", { name: "Staff sign in" }).click();
  await expect(
    staffPage.getByRole("button", { name: "Start camera" }),
  ).toBeVisible();
  await expect(
    staffPage.getByRole("button", { name: "Tickets", exact: true }),
  ).toHaveCount(0);
  const concurrent = await staffPage.evaluate(
    async ({ eventId, qr }) =>
      Promise.all(
        Array.from({ length: 5 }, async () => {
          const r = await fetch("/api/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ eventId, qr }),
          });
          return await r.json();
        }),
      ),
    { eventId, qr: decoded },
  );
  expect(concurrent.filter((r) => r.status === "admitted")).toHaveLength(1);
  expect(concurrent.filter((r) => r.status === "duplicate")).toHaveLength(4);
  // Feed the exported JPG through a virtual phone camera to exercise the real
  // camera reader and stop-after-one-scan behavior, without mocking the decoder.
  const directory = mkdtempSync(join(tmpdir(), "event-gate-camera-"));
  const frame = join(directory, "ticket.y4m");
  const height = Math.floor(pixels.height / 2) * 2,
    width = pixels.width;
  writeFileSync(
    frame,
    Buffer.concat([
      Buffer.from(
        `YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\nFRAME\n`,
      ),
      Buffer.from(pixels.gray.slice(0, width * height)),
      Buffer.alloc((width * height) / 2, 128),
    ]),
  );
  const cameraBrowser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${frame}`,
    ],
  });
  try {
    const phone = await cameraBrowser.newPage({
      baseURL: "http://localhost:3100",
      viewport: { width: 390, height: 844 },
    });
    await phone.goto("/");
    await phone.getByLabel("Email address").fill("checkin@example.com");
    await phone
      .getByLabel("Password", { exact: true })
      .fill("browser-test-only-password");
    await phone.getByRole("button", { name: "Staff sign in" }).click();
    await phone
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(
      phone.getByRole("heading", { name: "Already checked in" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      phone.getByRole("button", { name: "Start camera", exact: true }),
    ).toBeVisible();
  } finally {
    await cameraBrowser.close();
    rmSync(directory, { recursive: true, force: true });
  }
  await staffPage.getByLabel("Or enter QR text").fill(decoded);
  await staffPage
    .getByRole("button", { name: "Check ticket", exact: true })
    .click();
  await expect(
    staffPage.getByRole("heading", { name: "Already checked in" }),
  ).toBeVisible();
  await staffPage
    .getByRole("button", { name: "Request supervisor approval" })
    .click();
  await staffPage
    .getByRole("button", { name: "Re-entry", exact: true })
    .click();
  await expect(staffPage.getByText("Awaiting supervisor")).toBeVisible();
  await expect(
    staffPage.getByRole("button", { name: "Approve re-entry", exact: true }),
  ).toHaveCount(0);
  const denied = await staffPage.evaluate(async () => {
    const r = await fetch("/api/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "fake", approve: true }),
    });
    return r.status;
  });
  expect(denied).toBe(403);
  const supervisor = await browser.newContext({
    baseURL: "http://localhost:3100",
  });
  const supervisorPage = await supervisor.newPage();
  await supervisorPage.goto("/");
  await supervisorPage
    .getByLabel("Email address")
    .fill("supervisor@example.com");
  await supervisorPage
    .getByLabel("Password", { exact: true })
    .fill("browser-test-only-password");
  await supervisorPage.getByRole("button", { name: "Staff sign in" }).click();
  await supervisorPage
    .getByRole("button", { name: "Re-entry", exact: true })
    .click();
  await supervisorPage
    .getByPlaceholder("Reason / note (optional)")
    .fill("Comfort room");
  await supervisorPage
    .getByRole("button", { name: "Approve re-entry", exact: true })
    .click();
  await expect(
    supervisorPage.getByText("Re-entry approved", { exact: true }),
  ).toBeVisible();
  await staffPage.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    staffPage.getByText("Re-entry approved", { exact: true }),
  ).toBeVisible();
  await expect(staffPage.getByText(/Decision by: supervisor/)).toBeVisible();
  // Scan again: an earlier approval is not a permanent override.
  const again = await staffPage.evaluate(
    async ({ eventId, qr }) =>
      (
        await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId, qr }),
        })
      ).json(),
    { eventId, qr: decoded },
  );
  expect(again.status).toBe("duplicate");
  // Cancelling a ticket prevents even first/returning holders from entering.
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Cancel ticket", exact: true })
    .click();
  await expect(
    page.getByText("Cancelled ticket", { exact: true }),
  ).toBeVisible();
  const cancelled = await staffPage.evaluate(
    async ({ eventId, qr }) =>
      (
        await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId, qr }),
        })
      ).json(),
    { eventId, qr: decoded },
  );
  expect(cancelled.status).toBe("cancelled");
  // Cross-origin mutation is rejected even for an authenticated user.
  const csrf = await page.request.post("/api/events", {
    headers: { Origin: "https://untrusted.example" },
    data: {},
  });
  expect(csrf.status()).toBe(403);
  for (const [locale, label] of [
    ["ja", "チケット"],
    ["vi", "Vé"],
    ["zh-Hans", "票券"],
    ["zh-Hant", "票券"],
    ["en", "Tickets"],
  ]) {
    await page.getByLabel("Language / 言語").selectOption(locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/event-gate-mobile.png", fullPage: true });
  expect(errors).toEqual([]);
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Check-in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Staff sign in" }),
  ).toBeVisible();
  await staff.close();
  await supervisor.close();
});
