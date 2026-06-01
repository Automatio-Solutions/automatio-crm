-- Migration: añade rectifiesPurchaseInvoiceId a purchase_invoices.
-- Permite que una factura de proveedor sea una "rectificativa" que apunta
-- a otra factura original (mismo modelo que Invoice.rectifies_invoice_id).

ALTER TABLE "purchase_invoices"
    ADD COLUMN IF NOT EXISTS "rectifies_purchase_invoice_id" UUID;

-- Foreign key (self-referencing). Sin ON DELETE para evitar cascadas
-- en la factura original cuando se borre lógicamente una rectificativa.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoices_rectifies_fkey'
    ) THEN
        ALTER TABLE "purchase_invoices"
            ADD CONSTRAINT "purchase_invoices_rectifies_fkey"
            FOREIGN KEY ("rectifies_purchase_invoice_id")
            REFERENCES "purchase_invoices"("id")
            ON DELETE SET NULL;
    END IF;
END $$;
