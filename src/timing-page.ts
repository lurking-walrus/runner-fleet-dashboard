import { BRAND_CSS, FAVICON_LINK, brandTitle } from "./brand";
import html from "./timing.html";

// timing.html is a plain file (a text module), so the shared mark goes in through placeholders.
export const TIMING_HTML: string = html
  .replace("<!--brand:favicon-->", FAVICON_LINK)
  .replace("/*brand:css*/", BRAND_CSS)
  .replace("<!--brand:title-->Runner Fleet · Timings", brandTitle("Runner Fleet · Timings"));
