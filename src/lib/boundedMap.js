/* =========================================================================
 *  studio — a Map that keeps only its most recent entries
 *
 *  For caches that fill as you browse (search results, artist pages,
 *  lyrics, cover lookups): a plain Map holds every entry for as long as the
 *  app is open, so memory only ever grows. This one drops the entry used
 *  least recently once it holds `max`. Reading an entry counts as using it.
 * ========================================================================= */

export class BoundedMap extends Map {
  constructor(max) {
    super();
    this.max = Math.max(1, max | 0);
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const v = super.get(key);
    super.delete(key);
    super.set(key, v);
    return v;
  }

  set(key, value) {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    if (this.size > this.max) super.delete(this.keys().next().value);
    return this;
  }
}
