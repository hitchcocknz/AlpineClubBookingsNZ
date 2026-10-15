/**
 * #4146 (`INV-SSOT`): A PRISMA `startsWith` THAT MATCHES ITS PREFIX LITERALLY.
 *
 * Prisma (7.10, PostgreSQL) sends `startsWith: p` as `LIKE p || '%'` without
 * escaping `p`, so a `_` in the prefix matches any one character and a `%`
 * any run. A key prefix built from an id, such as
 * `duplicate_capture_<booking>_`, could then take another booking's row whose
 * key differs from it only where the prefix has a `_`.
 *
 * This escapes PostgreSQL's three `LIKE` metacharacters with its default
 * escape character, the backslash, so the pattern means only the text it
 * spells. Use it for every prefix that carries a caller-supplied id. It is
 * correct only while Prisma leaves the pattern unescaped: if Prisma ever
 * escapes it, the escape would be doubled and the filter would match nothing,
 * so `prisma-exact-prefix.realdb.test.ts` pins both halves against a real
 * database (Prisma still wildcards a bare `_`; this helper does not).
 *
 * `ILIKE` (`mode: "insensitive"`) uses the same escape character.
 */
export function exactPrefix(prefix: string): { startsWith: string } {
  return { startsWith: prefix.replace(/[\\%_]/g, "\\$&") };
}
