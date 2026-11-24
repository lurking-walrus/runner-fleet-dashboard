import { describe, expect, it } from "vitest";
import { FAVICON_LINK, LOGO_SVG } from "../src/brand";
import { loginPage } from "../src/aws/login";
import { FRONTEND_HTML } from "../src/frontend";
import { TIMING_HTML } from "../src/timing-page";

describe("brand mark", () => {
  it("is a self-contained SVG the favicon carries inline", () => {
    expect(LOGO_SVG.startsWith("<svg ")).toBe(true);
    expect(LOGO_SVG).not.toMatch(/href=|<script/); // nothing external, nothing executable
    expect(FAVICON_LINK).toContain('href="data:image/svg+xml,%3Csvg');
  });

  it.each([
    ["status", FRONTEND_HTML],
    ["timing", TIMING_HTML],
    ["login", loginPage({ next: "/" })],
  ])("the %s page has the favicon and the header mark, with no placeholder left", (_name, html) => {
    expect(html).toContain(FAVICON_LINK);
    expect(html).toMatch(/<h1><span class="brand-logo" aria-hidden="true"><svg /);
    expect(html).toContain(".brand-logo {");
    expect(html).not.toContain("brand:");
  });
});
