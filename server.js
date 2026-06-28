const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const mammoth = require('mammoth');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));

const IMAGE_TYPES = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.gif'];
const PDF_TYPES = ['.pdf'];
const DOC_TYPES = ['.docx'];
const TEXT_TYPES = ['.txt', '.md', '.csv'];

// A4 in points — all pages are normalized to this size
const STD_WIDTH = 595;
const STD_HEIGHT = 842;

function fitToBounds(contentW, contentH, boundsW, boundsH) {
  const scale = Math.min(boundsW / contentW, boundsH / contentH);
  const drawW = contentW * scale;
  const drawH = contentH * scale;
  return { scale, drawW, drawH, x: (boundsW - drawW) / 2, y: (boundsH - drawH) / 2 };
}

async function fileToPdfPages(filePath, ext, pdfDoc) {
  if (PDF_TYPES.includes(ext)) {
    const bytes = fs.readFileSync(filePath);
    const srcPdf = await PDFDocument.load(bytes);
    for (let i = 0; i < srcPdf.getPageCount(); i++) {
      const embedded = await pdfDoc.embedPage(srcPdf.getPage(i));
      const { width, height } = embedded.size();
      const { drawW, drawH, x, y } = fitToBounds(width, height, STD_WIDTH, STD_HEIGHT);
      const page = pdfDoc.addPage([STD_WIDTH, STD_HEIGHT]);
      page.drawPage(embedded, { x, y, width: drawW, height: drawH });
    }
  } else if (IMAGE_TYPES.includes(ext)) {
    const imgBytes = await sharp(filePath).jpeg({ quality: 90 }).toBuffer();
    const img = await pdfDoc.embedJpg(imgBytes);
    const imgMargin = 36;
    const { drawW, drawH, x, y } = fitToBounds(
      img.width, img.height,
      STD_WIDTH - imgMargin * 2, STD_HEIGHT - imgMargin * 2
    );
    const page = pdfDoc.addPage([STD_WIDTH, STD_HEIGHT]);
    page.drawImage(img, { x: x + imgMargin, y: y + imgMargin, width: drawW, height: drawH });
  } else if (DOC_TYPES.includes(ext)) {
    const result = await mammoth.extractRawText({ path: filePath });
    await addTextToPdf(pdfDoc, result.value);
  } else if (TEXT_TYPES.includes(ext)) {
    const text = fs.readFileSync(filePath, 'utf8');
    await addTextToPdf(pdfDoc, text);
  }
}

async function addTextToPdf(pdfDoc, text) {
  const { StandardFonts } = require('pdf-lib');
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const margin = 50;
  const pageWidth = STD_WIDTH;
  const pageHeight = STD_HEIGHT;
  const maxWidth = pageWidth - margin * 2;
  const lineHeight = fontSize * 1.4;

  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      const w = font.widthOfTextAtSize(test, fontSize);
      if (w > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }

  let y = pageHeight - margin;
  let page = pdfDoc.addPage([pageWidth, pageHeight]);

  for (const line of lines) {
    if (y < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
    page.drawText(line, { x: margin, y, size: fontSize, font });
    y -= lineHeight;
  }
}

app.post('/merge', upload.array('files'), async (req, res) => {
  const files = req.files;
  const outputName = (req.body.outputName || 'merged').replace(/[^a-zA-Z0-9_\-. ]/g, '_');

  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  let order = [];
  try {
    order = JSON.parse(req.body.order || '[]');
  } catch (_) {}

  let ordered = files;
  if (order.length > 0) {
    ordered = order.map(name => files.find(f => f.originalname === name)).filter(Boolean);
    const remaining = files.filter(f => !order.includes(f.originalname));
    ordered = [...ordered, ...remaining];
  }

  try {
    const pdfDoc = await PDFDocument.create();

    for (const file of ordered) {
      const ext = path.extname(file.originalname).toLowerCase();
      await fileToPdfPages(file.path, ext, pdfDoc);
    }

    const pdfBytes = await pdfDoc.save();

    for (const file of files) {
      fs.unlink(file.path, () => {});
    }

    const safeName = outputName.endsWith('.pdf') ? outputName : outputName + '.pdf';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}"`,
    });
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    for (const file of files) fs.unlink(file.path, () => {});
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`File Merger running on http://localhost:${PORT}`));
