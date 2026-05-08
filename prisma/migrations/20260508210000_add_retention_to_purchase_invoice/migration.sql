-- Migration: añadir retención (IRPF u otras) a facturas de proveedor.
--
-- Añade dos columnas a `purchase_invoices`:
--   retention_pct    NUMERIC(5,2) NOT NULL DEFAULT 0  -- p.ej. 7.00, 15.00
--   retention_cents  INTEGER      NOT NULL DEFAULT 0  -- importe absoluto retenido, en céntimos
--
-- No destructivo: las facturas existentes quedan con retención 0.
-- El total no cambia; las nuevas facturas pueden aplicar retención y la
-- aplicación calcula `retention_cents = round(subtotal_cents * retention_pct / 100)`
-- y `total_cents = subtotal_cents + tax_cents - retention_cents`.

ALTER TABLE "purchase_invoices"
    ADD COLUMN IF NOT EXISTS "retention_pct"   DECIMAL(5,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "retention_cents" INTEGER      NOT NULL DEFAULT 0;
