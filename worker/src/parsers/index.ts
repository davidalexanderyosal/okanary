import { parseCiti } from "./citi";
import type { ParsedAlert } from "./common";
import { parseDbs } from "./dbs";

export type Bank = "dbs" | "citi";
export const parseAlert = (bank: Bank, text: string, receivedAt: string): ParsedAlert | null => (bank === "dbs" ? parseDbs(text, receivedAt) : parseCiti(text, receivedAt));
export type { ParsedAlert } from "./common";
