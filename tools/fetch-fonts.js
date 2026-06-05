// Fetch the three Concord faces as static woff2 instances. Run once:
//   node tools/fetch-fonts.js
//
// Downloads latin-subset woff2 files from the Fontsource CDN (jsDelivr):
//   https://cdn.jsdelivr.net/fontsource/fonts/<family>@latest/latin-<weight>-<style>.woff2
//
//   Fraunces        400 / 600 / 900 normal, 400 italic   (display + verbatim quotes)
//   IBM Plex Sans   400 / 500 / 600 normal, 400 italic   (UI)
//   IBM Plex Mono   400 / 500 normal                     (data, labels, costs)
//
// Output: app/fonts/<family>-<weight>[-italic].woff2 plus app/fonts/OFL.txt
// (all three families are licensed under the SIL Open Font License 1.1; the
// license text is embedded below so this tool works even half-offline).
//
// The CSS in app/css/tokens.css declares @font-face with font-display: swap
// and full system fallback stacks — if this script never runs, the app still
// renders on Iowan/Georgia + system sans + Consolas. Missing files are
// reported per-face; the tool exits non-zero only if EVERY download failed.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT_DIR = fileURLToPath(new URL("../app/fonts/", import.meta.url));
const CDN = "https://cdn.jsdelivr.net/fontsource/fonts";

const FACES = [
  { family: "fraunces", weight: 400, style: "normal" },
  { family: "fraunces", weight: 400, style: "italic" },
  { family: "fraunces", weight: 600, style: "normal" },
  { family: "fraunces", weight: 900, style: "normal" },
  { family: "ibm-plex-sans", weight: 400, style: "normal" },
  { family: "ibm-plex-sans", weight: 400, style: "italic" },
  { family: "ibm-plex-sans", weight: 500, style: "normal" },
  { family: "ibm-plex-sans", weight: 600, style: "normal" },
  { family: "ibm-plex-mono", weight: 400, style: "normal" },
  { family: "ibm-plex-mono", weight: 500, style: "normal" },
];

function outName({ family, weight, style }) {
  return `${family}-${weight}${style === "italic" ? "-italic" : ""}.woff2`;
}

async function fetchFace(face) {
  const url = `${CDN}/${face.family}@latest/latin-${face.weight}-${face.style}.woff2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // woff2 magic: 77 4F 46 32 ("wOF2") — guard against CDN error pages
  if (buf.length < 4 || buf.toString("latin1", 0, 4) !== "wOF2") {
    throw new Error(`response is not woff2 (${buf.length} bytes) for ${url}`);
  }
  writeFileSync(OUT_DIR + outName(face), buf);
  return buf.length;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ok = [];
  const failed = [];
  for (const face of FACES) {
    try {
      const bytes = await fetchFace(face);
      ok.push(face);
      console.log(`  ✓ ${outName(face).padEnd(34)} ${(bytes / 1024).toFixed(1).padStart(6)} KB`);
    } catch (err) {
      failed.push(face);
      console.error(`  ✗ ${outName(face).padEnd(34)} ${err.message}`);
    }
  }
  writeFileSync(OUT_DIR + "OFL.txt", OFL_TEXT, "utf8");
  console.log(`\nWrote app/fonts/OFL.txt`);
  console.log(`${ok.length}/${FACES.length} faces fetched.`);
  if (failed.length === FACES.length) {
    console.error("Every download failed — check network. The UI will run on fallback stacks.");
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(`${failed.length} face(s) missing — the UI falls back per-face via font-display: swap.`);
  }
}

const OFL_TEXT = `Concord vendored fonts — license

The font files in this directory are subsets (latin) of:

  Fraunces
  Copyright 2020 The Fraunces Project Authors
  (https://github.com/undercasetype/Fraunces)

  IBM Plex Sans, IBM Plex Mono
  Copyright (c) 2017 IBM Corp. with Reserved Font Name "Plex"
  (https://github.com/IBM/plex)

All are licensed under the SIL Open Font License, Version 1.1, reproduced
in full below. Files were obtained as woff2 builds via Fontsource
(https://fontsource.org / https://cdn.jsdelivr.net/fontsource/).

-----------------------------------------------------------------------

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to any
document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may include
source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components
as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to
a new environment.

"Author" refers to any designer, engineer, programmer, technical writer
or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in
the appropriate machine-readable metadata fields within text or binary
files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the
corresponding Copyright Holder. This restriction only applies to the
primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must
be distributed entirely under this license, and must not be distributed
under any other license. The requirement for fonts to remain under this
license does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not
met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.
`;

main().catch((err) => {
  console.error(`fetch-fonts FAILED: ${err.message}`);
  process.exit(1);
});
