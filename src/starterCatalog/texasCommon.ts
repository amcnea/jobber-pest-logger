import type { StarterProduct } from "./types";

/**
 * Version stamp for the bundled Texas-common starter list.
 * Bump when rows are added/changed so offices can see which pack they searched.
 */
export const TEXAS_STARTER_CATALOG_VERSION = "2026.09.1";

/**
 * Curated, incomplete Texas structural-pest starter/reference list.
 * Not scraped from EPA/TDA; not official; office must confirm against the label.
 */
export const TEXAS_COMMON_STARTER: StarterProduct[] = [
  {
    id: "tx-advion-roach-gel",
    name: "Advion Cockroach Gel Bait",
    epaRegNo: "100-1484",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-advion-ant-gel",
    name: "Advion Ant Gel",
    epaRegNo: "100-1498",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-temprid-fx",
    name: "Temprid FX Insecticide",
    epaRegNo: "432-1544",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-demand-cs",
    name: "Demand CS Insecticide",
    epaRegNo: "100-1063",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-alpine-wsg",
    name: "Alpine WSG",
    epaRegNo: "499-561",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-phantom",
    name: "Phantom Termiticide-Insecticide",
    epaRegNo: "241-392",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-termidor-sc",
    name: "Termidor SC",
    epaRegNo: "7969-210",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-taurus-sc",
    name: "Taurus SC",
    epaRegNo: "53883-279",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-talstar-p",
    name: "Talstar Professional Insecticide",
    epaRegNo: "279-3206",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-bifen-it",
    name: "Bifen IT",
    epaRegNo: "53883-118",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-cyzmic-cs",
    name: "Cyzmic CS",
    epaRegNo: "53883-389",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-maxforce-fc-magnum",
    name: "Maxforce FC Magnum Roach Killer Bait Gel",
    epaRegNo: "432-1460",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-optigard-flex",
    name: "Optigard Flex Liquid",
    epaRegNo: "100-1306",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-transport-mikron",
    name: "Transport Mikron Insecticide",
    epaRegNo: "8033-109-279",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-contrac-blox",
    name: "Contrac Blox",
    epaRegNo: "12455-79",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-final-blox",
    name: "Final Blox",
    epaRegNo: "12455-89",
    is25b: false,
    kind: "pesticide",
  },
  {
    id: "tx-essentria-ic3",
    name: "Essentria IC3",
    epaRegNo: null,
    is25b: true,
    kind: "pesticide",
  },
  {
    id: "tx-ecovia-ec",
    name: "EcoVia EC",
    epaRegNo: null,
    is25b: true,
    kind: "pesticide",
  },
  {
    id: "tx-catchmaster-glue",
    name: "Catchmaster Insect Glue Board",
    epaRegNo: null,
    is25b: false,
    kind: "device",
  },
  {
    id: "tx-advanced-insect-monitor",
    name: "Advanced Insect Monitor",
    epaRegNo: null,
    is25b: false,
    kind: "device",
  },
];
