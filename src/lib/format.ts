/** Display numbers: comma grouping (en-IN, '1,180'; '1,00,000' from 100,000 up), the format of every kcal in the app (ring,
 * plate rows, Progress, Log, note rows); grams as whole numbers ('46 g'). One formatter so no row groups differently. */
export const kc = (n: number) => Math.round(n).toLocaleString('en-IN');
export const grams = (n: number) => `${Math.round(n)} g`;
