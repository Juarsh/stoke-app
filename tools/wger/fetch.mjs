// One-off: pull wger.de's public exercise API (no account) and keep the English translation and the fields we use.
// Output: tools/wger/snapshot.json (the input of curate.mjs). Data: wger.de contributors, CC BY-SA 4.0 / 3.0 / CC0 per row.
import { writeFileSync } from 'node:fs';
const all = [];
for (let o = 0; ; o += 100) {
  const r = await fetch(`https://wger.de/api/v2/exerciseinfo/?limit=100&offset=${o}`);
  if (!r.ok) throw new Error(`wger ${r.status}`);
  const j = await r.json(); all.push(...j.results);
  if (!j.next) break;
}
const lic = (l) => ({ id: l.id, short_name: l.short_name, url: l.url });
const out = all.flatMap((e) => {
  const t = e.translations.find((x) => x.language === 2);
  if (!t) return [];
  return [{ id: e.id, uuid: e.uuid, category: e.category.name, equipment: e.equipment.map((x) => x.name),
    muscles: e.muscles.map((m) => m.name_en || m.name), muscles_secondary: e.muscles_secondary.map((m) => m.name_en || m.name),
    license: lic(e.license), license_author: e.license_author, n_translations: e.translations.length, n_images: e.images.length,
    t: { id: t.id, name: t.name, description: t.description, aliases: t.aliases.map((a) => a.alias), license: t.license,
      license_author: t.license_author, author_history: t.author_history } }];
});
writeFileSync(new URL('./snapshot.json', import.meta.url), JSON.stringify({ fetched_at: new Date().toISOString(), source: 'https://wger.de/api/v2/exerciseinfo/', rows: out }));
console.log(`${out.length} English rows`);
