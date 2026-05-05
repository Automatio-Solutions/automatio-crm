// ============================================================
// Automatio CRM — Document Numbering
// Annual reset · Atomic increment · Formatted strings
// Format: F{YY}/{NN} for invoices, PRE-{YYYY}-{NNNN} for quotes
// ============================================================

import { prisma } from "./prisma";
import { DocType } from "@/generated/prisma/client";

/** Document type prefixes for formatted numbers */
const DOC_PREFIXES: Record<DocType, string> = {
    QUOTE: "PRE",
    INVOICE: "F",
    CREDIT_NOTE: "R",
    PURCHASE_INVOICE: "FP",
    PROFORMA_INVOICE: "PF",
};

/**
 * Format a document number based on its type.
 *
 * - INVOICE  → F{YY}/{NN}    (e.g. F26/03)
 * - CREDIT_NOTE → R{YY}/{NN}
 * - PROFORMA_INVOICE → PF{YY}/{NN}
 * - QUOTE    → PRE-{YYYY}-{NNNN}
 * - PURCHASE → FP-{YYYY}-{NNNN}
 */
function buildFormatted(docType: DocType, year: number, num: number): string {
    const prefix = DOC_PREFIXES[docType];

    if (docType === "INVOICE" || docType === "CREDIT_NOTE" || docType === "PROFORMA_INVOICE") {
        // Short format: F26/03 or R26/01 or PF26/01
        const yy = String(year % 100).padStart(2, "0");
        const nn = String(num).padStart(2, "0");
        return `${prefix}${yy}/${nn}`;
    }

    // Long format for quotes and purchases: PRE-2026-0001
    const padded = String(num).padStart(4, "0");
    return `${prefix}-${year}-${padded}`;
}

/**
 * Get the next document number atomically.
 * Uses a Prisma interactive transaction to avoid race conditions.
 *
 * @returns The new counter value and the formatted string
 *
 * @example
 * const { number, formatted } = await getNextNumber("INVOICE", 2026, companyId);
 * // => { number: 3, formatted: "F26/03" }
 */
export async function getNextNumber(
    docType: DocType,
    year: number,
    companyId: string
): Promise<{ number: number; formatted: string }> {
    return prisma.$transaction(async (tx) => {
        // Upsert: create counter if it doesn't exist for this year
        const counter = await tx.documentCounter.upsert({
            where: {
                companyId_year_docType: {
                    companyId,
                    year,
                    docType,
                },
            },
            update: {
                currentNumber: { increment: 1 },
            },
            create: {
                companyId,
                year,
                docType,
                currentNumber: 1,
            },
        });

        return {
            number: counter.currentNumber,
            formatted: buildFormatted(docType, year, counter.currentNumber),
        };
    });
}

/**
 * Format an existing document number.
 *
 * @example formatDocNumber("INVOICE", 2026, 3) => "F26/03"
 * @example formatDocNumber("QUOTE", 2026, 1)   => "PRE-2026-0001"
 */
export function formatDocNumber(
    docType: DocType,
    year: number,
    number: number
): string {
    return buildFormatted(docType, year, number);
}
