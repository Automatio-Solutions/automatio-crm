import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit";
import { NextResponse } from "next/server";

// GET /api/proformas — List proforma invoices
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const status = searchParams.get("status");
        const from = searchParams.get("from");
        const to = searchParams.get("to");

        const dateFilter: any = {};
        if (from) dateFilter.gte = new Date(from);
        if (to) {
            const toDate = new Date(to);
            toDate.setHours(23, 59, 59, 999);
            dateFilter.lte = toDate;
        }

        const proformas = await prisma.invoice.findMany({
            where: {
                deletedAt: null,
                type: "PROFORMA",
                ...(status ? { status: status as any } : {}),
                ...(from || to ? { createdAt: dateFilter } : {}),
            },
            include: {
                client: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        return NextResponse.json(proformas);
    } catch (error) {
        console.error("Error fetching proformas:", error);
        return NextResponse.json({ error: "Error al obtener proformas" }, { status: 500 });
    }
}

// POST /api/proformas — Create a new proforma invoice (DRAFT)
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { clientId, notes, publicNotes, issueDate, dueDate, lines } = body;

        if (!clientId) {
            return NextResponse.json({ error: "El cliente es obligatorio" }, { status: 400 });
        }
        if (!lines || lines.length === 0) {
            return NextResponse.json({ error: "Debe incluir al menos una línea" }, { status: 400 });
        }

        const company = await prisma.company.findFirst();
        if (!company) {
            return NextResponse.json({ error: "Empresa no configurada" }, { status: 500 });
        }

        // Calculate line totals
        const processedLines = (lines || []).map((line: any, idx: number) => {
            const qty = parseFloat(line.quantity) || 0;
            const unitCents = parseInt(line.unitPriceCents) || 0;
            const lineSubtotalCents = Math.round(qty * unitCents);

            const taxRate = parseFloat(line.taxRate) || 0;
            const lineTaxCents = Math.round(lineSubtotalCents * taxRate / 100);
            const lineTotalCents = lineSubtotalCents + lineTaxCents;

            return {
                position: idx + 1,
                description: line.description || "",
                details: line.details || null,
                quantity: qty,
                unitPriceCents: unitCents,
                taxId: line.taxId || null,
                lineSubtotalCents,
                lineTaxCents,
                lineTotalCents,
            };
        });

        const subtotalCents = processedLines.reduce((sum: number, l: any) => sum + l.lineSubtotalCents, 0);
        const taxCents = processedLines.reduce((sum: number, l: any) => sum + l.lineTaxCents, 0);
        const totalCents = subtotalCents + taxCents;

        const proforma = await prisma.invoice.create({
            data: {
                companyId: company.id,
                clientId,
                type: "PROFORMA",
                status: "DRAFT",
                notes: notes || null,
                publicNotes: publicNotes || null,
                issueDate: issueDate ? new Date(issueDate) : null,
                dueDate: dueDate ? new Date(dueDate) : null,
                subtotalCents,
                taxCents,
                totalCents,
                paidCents: 0,
                lines: {
                    create: processedLines,
                },
            },
            include: {
                client: { select: { id: true, name: true } },
                lines: { include: { tax: true }, orderBy: { position: "asc" } },
            },
        });

        await logActivity(company.id, null, "invoice", proforma.id, "CREATE", {
            type: "PROFORMA",
        });

        return NextResponse.json(proforma, { status: 201 });
    } catch (error) {
        console.error("Error creating proforma:", error);
        return NextResponse.json({ error: "Error al crear proforma" }, { status: 500 });
    }
}
