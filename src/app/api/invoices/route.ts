import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit";
import { NextResponse } from "next/server";

// GET /api/invoices — List invoices
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

        const invoices = await prisma.invoice.findMany({
            where: {
                deletedAt: null,
                type: { not: "PROFORMA" },
                ...(status ? { status: status as any } : {}),
                ...(from || to ? { createdAt: dateFilter } : {}),
            },
            include: {
                client: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        return NextResponse.json(invoices);
    } catch (error) {
        console.error("Error fetching invoices:", error);
        return NextResponse.json({ error: "Error al obtener facturas" }, { status: 500 });
    }
}

// POST /api/invoices — Create a new invoice directly (DRAFT, no quote needed)
// También soporta crear facturas rectificativas (CREDIT_NOTE) pasando
// rectifiesInvoiceId. En ese caso se hereda el cliente y se sugieren líneas.
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const {
            clientId: bodyClientId,
            notes,
            publicNotes,
            issueDate,
            dueDate,
            lines,
            rectifiesInvoiceId,
        } = body;

        // Si es rectificativa, heredamos el clientId de la factura original.
        let clientId = bodyClientId;
        let invoiceType: "INVOICE" | "CREDIT_NOTE" = "INVOICE";
        if (rectifiesInvoiceId) {
            const original = await prisma.invoice.findUnique({
                where: { id: rectifiesInvoiceId },
                select: { id: true, clientId: true, status: true },
            });
            if (!original) {
                return NextResponse.json(
                    { error: "Factura a rectificar no encontrada" },
                    { status: 404 }
                );
            }
            if (original.status === "DRAFT") {
                return NextResponse.json(
                    { error: "No tiene sentido rectificar un borrador (edítalo directamente)" },
                    { status: 400 }
                );
            }
            clientId = clientId || original.clientId;
            invoiceType = "CREDIT_NOTE";
        }

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

        const invoice = await prisma.invoice.create({
            data: {
                companyId: company.id,
                clientId,
                type: invoiceType,
                status: "DRAFT",
                notes: notes || null,
                publicNotes: publicNotes || null,
                issueDate: issueDate ? new Date(issueDate) : null,
                dueDate: dueDate ? new Date(dueDate) : null,
                subtotalCents,
                taxCents,
                totalCents,
                paidCents: 0,
                // Si viene de rectificación, enlazamos a la factura original
                rectifiesInvoiceId: rectifiesInvoiceId || null,
                // sourceQuoteId is null — direct invoice creation
                lines: {
                    create: processedLines,
                },
            },
            include: {
                client: { select: { id: true, name: true } },
                lines: { include: { tax: true }, orderBy: { position: "asc" } },
            },
        });

        await logActivity(company.id, null, "invoice", invoice.id, "CREATE", {
            direct: true,
            rectifying: !!rectifiesInvoiceId,
        });

        return NextResponse.json(invoice, { status: 201 });
    } catch (error) {
        console.error("Error creating invoice:", error);
        return NextResponse.json({ error: "Error al crear factura" }, { status: 500 });
    }
}
