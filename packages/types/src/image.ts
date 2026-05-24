/**
 * ImageObject — reusable image reference (icons, screenshots, badges).
 * See rfcs/image-object.md.
 */
export interface ImageObject {
  /** Vector source (preferred when present). Path or URL. */
  svg?: string;
  /** Sized raster sources, keyed by `"<w>x<h>"` (e.g. `"128x128"`). Path or URL. */
  sizes?: Record<string, string>;
  /** Single raster source when no `sizes` map is provided. */
  url?: string;
  /** Accessible alternative text. */
  alt?: string;
  /** Caption shown beneath the image. */
  caption?: string;
}
