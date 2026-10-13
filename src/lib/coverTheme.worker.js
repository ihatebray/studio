/* The cover palette analysis, on its own thread.
 *
 * Reading a cover's colors (clustering several thousand pixels a few ways
 * and scoring the results) takes a few hundred milliseconds. On the page's
 * thread that froze whatever was animating when a song started, the Now
 * Playing bar and side panel included. Here it runs beside the page instead.
 * Same code and the same pixels as before, so the colors are identical.
 */
import { analyzeSamples, themeFromAnalysis } from './coverTheme.js';
import { analyseCover } from './coverColour.js';

self.onmessage = (e) => {
  const { id, rgb } = e.data || {};
  try {
    const samples = new Array(rgb.length / 3);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 1) samples[j] = [rgb[i], rgb[i + 1], rgb[i + 2]];
    const theme = themeFromAnalysis({ ...analyzeSamples(samples), perceptual: analyseCover(samples) });
    self.postMessage({ id, theme });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
