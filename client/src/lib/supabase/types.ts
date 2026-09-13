/**
 * Row shapes for the Postgres tables, and the mappers to domain types.
 *
 * Postgres columns are snake_case and the domain types are camelCase, so the
 * translation has to live somewhere. Putting it here — in one file, typed both
 * ways — means a renamed column breaks the build instead of silently reading
 * `undefined` into a money field at runtime.
 *
 * `user_id` never appears in a domain type. It is a storage concern: the
 * client sets it on write and RLS enforces it on read, so nothing above this
 * layer needs to know a row belongs to anyone.
 */
import type {
  Transaction,
  PortfolioSnapshot,
  BudgetEntry,
  AssetClass,
} from '@aminfinance/shared';

// Type aliases, not interfaces. The client validates rows with a mapped
// conditional type, and that requires the implicit index signature an alias
// has and an interface does not — declared as interfaces, every row resolves
// to `never` and valid writes fail to compile.
export type TransactionRow = {
  id: string;
  user_id: string;
  symbol: string;
  asset_class: AssetClass;
  type: Transaction['type'];
  quantity: number;
  price: number;
  fee: number;
  currency: string;
  timestamp: number;
  source: Transaction['source'];
  external_id: string | null;
  notes: string | null;
}

export type SnapshotRow = {
  user_id: string;
  timestamp: number;
  total_value: number;
  total_cost_basis: number;
}

export type BudgetRow = {
  id: string;
  user_id: string;
  kind: BudgetEntry['kind'];
  category: BudgetEntry['category'];
  amount: number;
  currency: string;
  timestamp: number;
  month: string;
  recurring: boolean;
  item_id: string | null;
  label: string | null;
  note: string | null;
}

/**
 * Shaped the way `supabase-js` expects its generated types.
 *
 * The empty `Relationships`, `Views`, `Functions`, `Enums` and
 * `CompositeTypes` members are not decoration: the client's generics walk
 * every one of them, and a table missing `Relationships` resolves its insert
 * parameter to `never`, which rejects perfectly valid rows at compile time.
 */
export type Database = {
  public: {
    Tables: {
      transactions: {
        Row: TransactionRow;
        Insert: TransactionRow;
        Update: Partial<TransactionRow>;
        Relationships: [];
      };
      snapshots: {
        Row: SnapshotRow;
        Insert: SnapshotRow;
        Update: Partial<SnapshotRow>;
        Relationships: [];
      };
      budget: {
        Row: BudgetRow;
        Insert: BudgetRow;
        Update: Partial<BudgetRow>;
        Relationships: [];
      };
    };
    // Unused, but present: the client's generics walk all five members, and
    // omitting one resolves the schema to `never`.
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

// ------------------------------------------------------------------ mappers
//
// Nullable columns become absent properties, not `null`. The domain types use
// optional fields, and letting a `null` through would make `entry.note ?? ''`
// behave one way for a local row and another for a fetched one.

export function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    symbol: row.symbol,
    assetClass: row.asset_class,
    type: row.type,
    // Postgres `numeric` arrives as a string when the value exceeds what the
    // driver will coerce, so every money column is parsed rather than cast.
    quantity: Number(row.quantity),
    price: Number(row.price),
    fee: Number(row.fee),
    currency: row.currency,
    timestamp: Number(row.timestamp),
    source: row.source,
    ...(row.external_id !== null && { externalId: row.external_id }),
    ...(row.notes !== null && { notes: row.notes }),
  };
}

export function fromTransaction(tx: Transaction, userId: string): TransactionRow {
  return {
    id: tx.id,
    user_id: userId,
    symbol: tx.symbol,
    asset_class: tx.assetClass,
    type: tx.type,
    quantity: tx.quantity,
    price: tx.price,
    fee: tx.fee,
    currency: tx.currency,
    timestamp: tx.timestamp,
    source: tx.source,
    external_id: tx.externalId ?? null,
    notes: tx.notes ?? null,
  };
}

export function toSnapshot(row: SnapshotRow): PortfolioSnapshot & { id: number } {
  const timestamp = Number(row.timestamp);
  return {
    // Dexie keyed snapshots by timestamp and the UI still reads `id`; keeping
    // the alias here means the swap does not ripple into the chart code.
    id: timestamp,
    timestamp,
    totalValue: Number(row.total_value),
    totalCostBasis: Number(row.total_cost_basis),
  };
}

export function fromSnapshot(s: PortfolioSnapshot, userId: string): SnapshotRow {
  return {
    user_id: userId,
    timestamp: s.timestamp,
    total_value: s.totalValue,
    total_cost_basis: s.totalCostBasis,
  };
}

export function toBudgetEntry(row: BudgetRow): BudgetEntry {
  return {
    id: row.id,
    kind: row.kind,
    category: row.category,
    amount: Number(row.amount),
    currency: row.currency,
    timestamp: Number(row.timestamp),
    month: row.month,
    recurring: row.recurring,
    ...(row.item_id !== null && { itemId: row.item_id }),
    ...(row.label !== null && { label: row.label }),
    ...(row.note !== null && { note: row.note }),
  };
}

export function fromBudgetEntry(entry: BudgetEntry, userId: string): BudgetRow {
  return {
    id: entry.id,
    user_id: userId,
    kind: entry.kind,
    category: entry.category,
    amount: entry.amount,
    currency: entry.currency,
    timestamp: entry.timestamp,
    month: entry.month,
    recurring: entry.recurring,
    item_id: entry.itemId ?? null,
    label: entry.label ?? null,
    note: entry.note ?? null,
  };
}
