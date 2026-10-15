/** Display numbers: comma grouping (en-IN, '1,180'); grams as whole numbers ('46 g'). */
export const kc = (n: number) => Math.round(n).toLocaleString('en-IN');
export const grams = (n: number) => `${Math.round(n)} g`;
