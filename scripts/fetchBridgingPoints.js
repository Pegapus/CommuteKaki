require('dotenv').config({ path: '.env' });
const ExcelJS = require('exceljs');
const { saveBridgingPoints } = require('../models/BridgingPoints');
const { disconnect } = require('../configs/database');

async function fetchBridgingPointsSheet(sheetId) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=xlsx`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Google Sheets returned ${response.status}. Ensure the sheet is publicly shared or the ID is correct.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
        throw new Error('Bridging points sheet has no worksheets.');
    }

    const maxCol = worksheet.columnCount || 1;
    const rows = [];
    // Rows 1-5 are title/legend, row 6 is the "Line | Station | BS/BI Code" header.
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        if (rowNumber < 7) return;
        const line = String(row.getCell(1).text || '').trim();
        const station = String(row.getCell(2).text || '').trim();
        if (!station) return;
        const codes = [];
        for (let c = 3; c <= maxCol; c++) {
            const cell = row.getCell(c);
            const cellText = String(cell.text || '').trim();
            if (!cellText) continue;
            
            let type = 'both'; // default to yellow
            if (cell.style.fill && cell.style.fill.fgColor && cell.style.fill.fgColor.argb) {
                const argb = cell.style.fill.fgColor.argb.toUpperCase();
                // FFC5E0B3 or similar is green
                if (argb.includes('C5E0B3') || argb === 'FF92D050' || argb.includes('00B050') || argb.includes('548235')) {
                    type = 'alight_only';
                }
            }

            cellText.split(/[,;\s\/]+/).forEach(part => {
                const trimmed = part.trim();
                if (!trimmed) return;
                
                let code = trimmed;
                if (/^\d{4,5}$/.test(trimmed)) {
                    code = trimmed.padStart(5, '0');
                }
                codes.push({ code, type });
            });
        }
        if (codes.length) rows.push({ line, station, codes });
    });

    if (rows.length === 0) {
        throw new Error('No station/bus-stop rows found in bridging points sheet (expected data starting row 7).');
    }
    return rows;
}

async function run() {
    if (!process.env.BRIDGING_POINTS_SHEET_ID) {
        console.error("Missing BRIDGING_POINTS_SHEET_ID in environment variables.");
        process.exit(1);
    }
    try {
        console.log("Fetching bridging points from Google Sheets...");
        const data = await fetchBridgingPointsSheet(process.env.BRIDGING_POINTS_SHEET_ID);
        console.log(`Fetched ${data.length} bridging point entries. Saving to database...`);
        await saveBridgingPoints(data);
        console.log("Successfully saved bridging points to database.");
    } catch (error) {
        console.error("Error fetching and saving bridging points:", error);
    } finally {
        await disconnect();
    }
}

run();
