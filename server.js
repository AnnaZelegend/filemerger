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

// Supported types for merging into PDF
const IMAGE_TYPES = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.gif'];
const PDF_TYPES = ['.pdf'];
const DOC_TYPES = ['.docx'];
const TEXT_TYPES = ['.txt', '.md', '.csv'];

async function fileToPdfPages(filePath, ext, pdfDoc) {
  if (PDF_TYPES.includes(ext)) {
    const bytes = fs.readFileSync(filePath);
    const srcPdf = await PDFDocument.load(bytes);
    const pages = await pdfDoc.copyPages(srcPdf, srcPdf.getPageIndices());
    pages.forEach(p => pdfDoc.addPage(p));
  } else if (IMAGE_TYPES.includes(ext)) {
    const imgBytes = await sharp(filePath).jpeg({ quality: 90 }).toBuffer();
    const img = await pdfDoc.embedJpg(imgBytes);
    const page = pdfDoc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  } else if (DOC_TYPES.includes(ext)) {
    const result = await mammoth.extractRawText({ path: filePath });
    const text = result.value;
    await addTextToPdf(pdfDoc, text);
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
  const pageWidth = 595;
  const pageHeight = 842;
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

  // Parse order from client (comma-separated original names)
  let order = [];
  try {
    order = JSON.parse(req.body.order || '[]');
  } catch (_) {}

  // Sort files by requested order if provided
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

    // Cleanup uploads
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
