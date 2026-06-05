// Generates all ingest test fixtures (prefix `ingest-`) into tests/fixtures/.
// Deterministic: running twice produces byte-identical files (except XLSX,
// which embeds no timestamps the way we build it — see compression options).
// Run:  node tests/fixtures/make-ingest-fixtures.js
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";
import XLSX from "xlsx";

const here = dirname(fileURLToPath(import.meta.url));
const out = (name) => join(here, name);

// ---------------------------------------------------------------- CSV (comma)
// BOM + quoted embedded newline + "" escapes + one ragged row + Spanish row.
{
  const lines = [
    "id,response,score",
    'r1,"She said ""hello"" to me",4',
    'r2,"First line\nsecond line of same cell",5',
    "r3,short answer", // ragged: 2 cells, needs padding
    'r4,"La gestión era terrible, pero el equipo increíble",2',
    "r5,plain text,3",
  ];
  writeFileSync(out("ingest-basic.csv"), "﻿" + lines.join("\r\n") + "\r\n", "utf8");
}

// ------------------------------------------------------- CSV (semicolon-delim)
{
  const lines = [
    "name;city;notes",
    'Ana;Madrid;"uses, commas; here"',
    "Ben;Lisbon;fine",
  ];
  writeFileSync(out("ingest-semicolon.csv"), lines.join("\n") + "\n", "utf8");
}

// ----------------------------------------------------------------- XLSX 3-sheet
{
  const wb = XLSX.utils.book_new();
  const s1 = XLSX.utils.aoa_to_sheet([
    ["id", "answer", "when"],
    ["a1", "Loved the workshop", new Date(Date.UTC(2024, 0, 15))],
    ["a2", "Too long, but useful", new Date(Date.UTC(2024, 1, 2))],
  ]);
  const s2 = XLSX.utils.aoa_to_sheet([
    ["id", "answer"],
    ["b1", "Second sheet row"],
  ]);
  const s3 = XLSX.utils.aoa_to_sheet([
    ["k", "v"],
    ["pi", 3.14],
  ]);
  XLSX.utils.book_append_sheet(wb, s1, "Wave1");
  XLSX.utils.book_append_sheet(wb, s2, "Wave2");
  XLSX.utils.book_append_sheet(wb, s3, "Stats");
  XLSX.writeFile(wb, out("ingest-three-sheets.xlsx"), { cellDates: true, compression: true });
}

// -------------------------------------------------------------- DOCX via fflate
{
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>First paragraph from DOCX.</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Second paragraph with café text.</w:t></w:r></w:p>
<w:p><w:r><w:t>Third one.</w:t></w:r></w:p>
</w:body>
</w:document>`;
  const zipped = zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(rels),
      "word/document.xml": strToU8(document),
    },
    { level: 6, mtime: new Date(Date.UTC(2024, 0, 1)) }
  );
  writeFileSync(out("ingest-min.docx"), zipped);
}

// ------------------------------------------------- PDF 1.4, hand-authored bytes
// Two text objects far apart vertically -> pdf.js parser must yield two paras.
{
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
    "/Resources << /Font << /F1 5 0 R >> >> >>";
  const stream =
    "BT /F1 12 Tf 72 720 Td (Hello from Concord PDF.) Tj ET\n" +
    "BT /F1 12 Tf 72 600 Td (Second paragraph here.) Tj ET";
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objs.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < objs.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  writeFileSync(out("ingest-min.pdf"), Buffer.from(pdf, "latin1"));
}

// ----------------------------------------------------------------------- VTT
// Hour-format timestamps + consecutive same-speaker cues (must merge).
{
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Alice>Hello everyone.

01:02:03.500 --> 01:02:06.000
<v Alice>Welcome to the meeting.

01:02:07.000 --> 01:02:09.250
<v Bob>Thanks Alice.
`;
  writeFileSync(out("ingest-sample.vtt"), vtt, "utf8");
}

// ----------------------------------------------------------------------- SRT
{
  const srt = `1
00:00:01,000 --> 00:00:03,000
Alice: Hello there.

2
00:00:04,000 --> 00:00:06,500
Alice: How are you today?

3
00:00:07,500 --> 00:00:09,000
Bob: Doing well, thanks.
`;
  writeFileSync(out("ingest-sample.srt"), srt, "utf8");
}

// --------------------------------------------------------- Zoom-style JSON
{
  const zoom = {
    recording_id: "rec_001",
    transcripts: [
      { speaker: "Carol", start_time: "00:00:01.200", end_time: "00:00:04.000", text: "Let us begin." },
      { speaker: "Carol", start_time: "00:00:04.500", end_time: "00:00:07.000", text: "First item is budget." },
      { speaker: "Dan", start_time: "00:00:08.000", end_time: "00:00:10.000", text: "Sounds good." },
    ],
  };
  writeFileSync(out("ingest-zoom.json"), JSON.stringify(zoom, null, 2), "utf8");
}

// ----------------------------------------------------------- TXT / MD / HTML
{
  writeFileSync(
    out("ingest-sample.txt"),
    "First paragraph of plain text.\nStill the first paragraph.\n\nSecond paragraph here.\n\n\nThird paragraph after extra blanks.\n",
    "utf8"
  );
  writeFileSync(
    out("ingest-sample.html"),
    `<!doctype html><html><head><title>T</title>
<style>p { color: red; }</style><script>var x = "<p>not text</p>";</script></head>
<body><h1>Heading One</h1><p>First <b>bold</b> paragraph &amp; more.</p>
<div>Second block<br>with a break.</div><!-- comment --></body></html>`,
    "utf8"
  );
}

console.log("ingest fixtures written to", here);
