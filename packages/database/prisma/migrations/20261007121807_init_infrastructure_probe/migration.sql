-- CreateTable
CREATE TABLE "infrastructure_probes" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "infrastructure_probes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "infrastructure_probes_label_key" ON "infrastructure_probes"("label");
