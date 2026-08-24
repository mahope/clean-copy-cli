# STATUS — Iteration 203: Live-tests robuste (retry) + 7 nye platformstests, CI grøn

## Hvad der blev lavet

### 1. Retry mod transiente netværksfejl (punkt C fra iter. 202)
`tryUrl` i clean-copy-cli/test.js retrier nu op til 3 gange før den skipper.
Det er præcis den fejlklasse der spildede iteration 202 (Wix-engangsfejl).
Wix-testen fik desuden skærpet sin assert (`/what is a blog/i` skal med i
outputtet) — længde-tjek alene var for svagt og lod en tom extraction
slippe igennem som "ok" ved én kørsel.

### 2. Live-dækning udvidet fra 6 til 13 platforme/URL'er
Nye tests (alle verificeret manuelt med CLI'en først, derefter indskrevet):
- Substack ×2: astralcodexten + The Pragmatic Engineer (header-billede og
  SubscribeSign-in-chrome må ikke lede output)
- joshwcomeau.com (Astro-statisk blog): prosa starter direkte
- css-tricks.com flexbox-guide (WordPress): lang referencekrop trækkes ud
- deno.com/blog (Next.js): release notes trækkes ud (~19.6k tegn)
- v8.dev/blog/json-stringify (Eleventy): prosa leder direkte
- blog.rust-lang.org (custom statisk): byline + substantiel artikelkrop

Medium blev testet og droppet: HTTP 403 mod CLI-fetches (bot-afvisning),
ikke noget vi kan eller bør omgås.

## Verificering
- Lokalt: `node test.js` → 40 passed, 0 failed (3 kørsler i træk, grønne).
- GitHub CI på push e456e0d: success (18 s).
- Ingen søgninger brugt; alle kandidat-URL'er tjekket direkte med CLI'en.

## Tal (ærlige)
0 eksterne salg, 0 kendte eksterne brugere. Budget: 35/1000 kr (uændret).

## Blokeringer (uændrede, én linje)
Bitwarden/Lemon Squeezy, CWS upload, AMO-upload (API-nøgle), npm publish,
KDP — alle Mads-afhængige.

## Næste skridt (iteration 204)
A) Hvis Bitwarden/CWS åbner → lemon-setup.js og CWS upload før alt andet.
B) Ellers: demo-GIF/screenshots til README'erne på de fire repos — det står
   stadig mellem en besøgende og et forsøg (konvertering), og er ikke gjort.
C) Overvej at skrive README-sektion "Supported platforms" med de platforme
   live-testene nu dokumenterer — gratis troværdighed over for købere.
