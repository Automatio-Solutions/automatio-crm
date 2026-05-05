import { prisma } from "@/lib/prisma";
import { getNextNumber } from "@/lib/numbering";
import { logActivity } from "@/lib/audit";
import { NextResponse } from "next/server";

// POST /api/proformas/[id]/emit — Assign proforma number + DRAFT → ISSUED
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        const invoice = await prisma.invoice.findUnique({
            where: { id, deletedAt: null },
            include: { client: { select: { paymentTermsDays: true } } },
        });
        if (!invoice) {
            return NextResponse.json({ error: "Proforma no encontrada" }, { status: 404 });
        }
        if (invoice.type !== "PROFORMA") {
            return NextResponse.json({ error: "Este documento no es una proforma" }, { status: 400 });
        }
        if (invoice.status !== "DRAFT") {
            return NextResponse.json({ error: "Solo se puede emitir una proforma en borrador" }, { status: 400 });
        }

        const year = new Date().getFullYear();
        const companyId = invoice.companyId;

        const issueDate = invoice.issueDate ?? new Date();
        const termsDays = invoice.client?.paymentTermsDays ?? 30;
        const dueDate = new Date(issueDate);
        dueDate.setDate(dueDate.getDate() + termsDays);

        const updated = await prisma.$transaction(async (tx) => {
            const { formatted } = await getNextNumber("PROFORMA_INVOICE", year, companyId);

            return tx.invoice.update({
                where: { id },
                data: {
                    number: formatted,
                    year,
                    status: "ISSUED",
                    issueDate,
                    dueDate,
                },
                include: {
                    client: { select: { id: true, name: true, taxId: true, email: true } },
                    lines: { include: { tax: true }, orderBy: { position: "asc" } },
                },
            });
        });

        await logActivity(companyId, null, "invoice", id, "EMIT", {
            number: updated.number,
            year: updated.year,
            type: "PROFORMA",
        });

        return NextResponse.json(updated);
    } catch (error) {
        console.error("Error emitting proforma:", error);
        return NextResponse.json({ error: "Error al emitir proforma" }, { status: 500 });
    }
}
