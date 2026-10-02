// Builds a .docx containing real Word equations, in the page, on purpose.
//
// The suite keeps binary fixtures out of the repository, and a maths document is
// not something worth writing a generator for twice. So this assembles the
// package with the site's own JSZip loader, from XML written out here: the point
// is that the file the converter is handed is the same shape Word writes, with
// the same OMML element names, rather than something convenient to generate.
//
// Call it inside page.evaluate - it is self-contained and uses only what is
// already loaded on the page.
export function buildMathsDocx() {
  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const m = (s) => `<m:r><m:t>${s}</m:t></m:r>`;

  const body = [
    // A square root with a superscript inside it, then a fraction.
    `<w:p><m:oMath>
       <m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>
         <m:e>${m("x")}<m:sSup><m:e>${m("2")}</m:e><m:sup>${m("2")}</m:sup></m:sSup></m:e>
       </m:rad>
       ${m(" = ")}
       <m:f><m:num>${m("a+b")}</m:num><m:den>${m("2c")}</m:den></m:f>
     </m:oMath></w:p>`,
    // A summation with a lower and an upper limit, as its own block.
    `<w:p><m:oMathPara><m:oMath>
       <m:nary><m:naryPr><m:chr m:val="&#8721;"/></m:naryPr>
         <m:sub>${m("i=1")}</m:sub><m:sup>${m("n")}</m:sup>
         <m:e>${m("pi")}<m:sSup><m:e>${m("2")}</m:e><m:sup>${m("2")}</m:sup></m:sSup></m:e>
       </m:nary>
     </m:oMath></m:oMathPara></w:p>`,
    // The relation and set operators, as one run of maths between words.
    `<w:p><w:r><w:t>Relations:</w:t></w:r>
       <m:oMath>${m("x")}${m("&#8804;")}${m("y")}${m("&#8800;")}${m("z")}${m("&#8776;")}${m("w")}${m("&#8594;")}${m("&#8734;")}${m("&#8712;")}${m("R")}${m("&#8746;")}${m("S")}</m:oMath></w:p>`,
    // A cube root, and a run Word stores in the Symbol font.
    `<w:p><m:oMath>
       <m:rad><m:radPr><m:degHide m:val="0"/></m:radPr><m:deg>${m("3")}</m:deg><m:e>${m("x+y")}</m:e></m:rad>
       ${m(" and ")}
       <m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>${m("a,b,c")}</m:e></m:d>
     </m:oMath><w:r><w:sym w:font="Symbol" w:char="F0D6"/></w:r></w:p>`,
    // Greek, in both the letter and the symbol form of the alphabet.
    `<w:p><w:r><w:t>Greek:</w:t></w:r>
       <m:oMath>${m("&#945;&#946;&#948;&#960;&#963;&#969; &#916;&#931;&#937;&#928;")}</m:oMath></w:p>`,
    // Ordinary prose, so a test can tell the maths was added rather than the
    // whole reader rewritten.
    `<w:p><w:r><w:t>Ordinary prose that must be unaffected.</w:t></w:r></w:p>`,
  ].join("");

  return loadJsZip().then((JSZip) => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
         <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
         <Default Extension="xml" ContentType="application/xml"/>
         <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
       </Types>`
    );
    zip.folder("_rels").file(
      ".rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
         <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
       </Relationships>`
    );
    zip.folder("word").folder("_rels").file(
      "document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`
    );
    zip.folder("word").file(
      "document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`
    );
    return zip.generateAsync({ type: "uint8array" });
  }).then((bytes) => new File([bytes], "maths.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
}
// The smallest document that can hold a sentence: used to check that ordinary
// Latin-1 text is written as itself rather than replaced.
export function buildDocxWithText(text) {
  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  return loadJsZip().then((JSZip) => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
         <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
         <Default Extension="xml" ContentType="application/xml"/>
         <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
       </Types>`
    );
    zip.folder("_rels").file(
      ".rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
         <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
       </Relationships>`
    );
    zip.folder("word").folder("_rels").file(
      "document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`
    );
    const escaped = String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    zip.folder("word").file(
      "document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>` +
        `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>` +
        `</w:body></w:document>`
    );
    return zip.generateAsync({ type: "uint8array" });
  }).then((bytes) => new File([bytes], "text.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
}
