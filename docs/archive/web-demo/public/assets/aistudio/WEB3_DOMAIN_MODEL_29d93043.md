WEB3_DOMAIN_MODEL.md — Modelo de Dominio Pre-Web3, Reservas y Liquidación
Proyecto: GigaForge v4.1
Entregable: C (Backlog P0)
Corte de diseño: 26 de octubre de 2026
Propósito: Definir las entidades, invariantes contables y adaptadores en TypeScript para que el simulador off-chain soporte propiedad, licencias de uso y liquidación de lotes on-chain en la Fase 3, sin escribir contratos en Solidity prematuramente ni acoplar el MVP a una blockchain específica.


________________


1. Separación de Capas y Frontera de Custodia
El modelo de dominio divide estrictamente la contabilidad rápida del juego (SQLite/PostgreSQL por ticks) de la liquidación externa (EVM / Base / Ronin / GalaChain):


* Invariante 1 (Conservación de Materiales): Un ítem del inventario (STEEL_PLATE, IND_TURBINE) nunca puede estar simultáneamente disponible para uso en la fábrica y empaquetado como lote comercializable Web3 (LotReceipt).
* Invariante 2 (Separación de Propiedad y Uso): Toda verificación de capacidad especial en el simulador (ej. usar un Blueprint optimizado) consulta la entidad UsageRight (Derecho de Uso activo en el tick actual), no directamente la entidad Ownership (Titularidad del activo). Esto permite probar alquileres 100% off-chain en la Fase 2 y mapearlos a ERC-4907 en la Fase 3 sin cambiar la lógica de la fábrica.


________________


2. Entidades Nucleares del Dominio (Interfaces TypeScript)
// 1. ASSET: Representa un activo escaso o derecho catalogado (ej. Blueprint, Licencia Industrial)


export type AssetCategory = 'BLUEPRINT_MODIFIER' | 'FACILITY_DEED' | 'COMMODITY_LOT';


export interface Asset {


  readonly assetId: string;          // ID interno canónico (ej. "ast_bp_arc_furnace_v2")


  readonly category: AssetCategory;


  readonly metadataCode: string;     // Código inmutable de reglas aplicadas en el simulador


  readonly isTokenizable: boolean;   // False en Fase 1-2; True en Fase 3+ si cruza el puente


  readonly onChainTokenId?: string;  // Mapeo opcional a ERC-721 / ERC-1155


  readonly chainId?: string;


}


// 2. OWNERSHIP: Quién es el dueño legal/económico del activo


export interface Ownership {


  readonly assetId: string;


  readonly ownerCompanyId: string;   // Empresa titular dentro del juego


  readonly ownerWalletAddress?: string;


  readonly custodyState: 'OFF_CHAIN_LEDGER' | 'LOCKED_IN_ESCROW' | 'MINTED_ON_CHAIN';


  readonly updatedAtTick: number;


}


// 3. USAGE RIGHT: Quién tiene derecho a utilizar el activo en la fábrica (Soporte Alquiler / Gremios)


export interface UsageRight {


  readonly usageId: string;


  readonly assetId: string;


  readonly beneficiaryCompanyId: string; // Puede ser distinto de ownerCompanyId si es alquilado


  readonly validFromTick: number;


  readonly expiresAtTick: number;        // Expiración determinista por tick (inspirado en ERC-4907)


  readonly revenueShareBps: number;      // Puntos básicos (ej. 1000 = 10%) si aplica acuerdo de gremio


  readonly isActive: boolean;


}


// 4. INVENTORY RESERVATION & LOT: Empaquetado de recursos off-chain en lotes auditables


export type LotStatus = 


  | 'RESERVED_OFF_CHAIN'   // Materiales restados del stock disponible y bloqueados


  | 'TOKENIZED_RECEIPT'    // Recibo emitido (ERC-1155 / compromiso firmado)


  | 'IN_ESCROW'            // Depositado en contrato o mercado para venta B2B


  | 'SETTLED_PENDING_CLAIM'// Pagado; pendiente de acreditación al comprador


  | 'CONSUMED_UNPACKED'    // Materiales acreditados al comprador; recibo invalidado/quemado


  | 'CANCELLED_RESTORED';  // Reserva cancelada por el dueño; materiales devueltos al stock


export interface CommodityLot {


  readonly lotId: string;                // UUID único e irrepetible


  readonly originCompanyId: string;


  readonly currentHolderCompanyId: string;


  readonly itemId: string;               // Ej. "STEEL_PLATE"


  readonly quantity: number;             // Entero estricto (ej. 1000 unidades)


  readonly reservationId: string;


  readonly status: LotStatus;


  readonly stateHash: string;            // Hash de integridad (lotId + itemId + quantity + origin)


  readonly createdAtTick: number;


}


// 5. ESCROW & SETTLEMENT: Liquidación segura de intercambios


export interface TradeEscrowRecord {


  readonly escrowId: string;


  readonly lotId: string;


  readonly sellerCompanyId: string;


  readonly buyerCompanyId: string;


  readonly agreedPriceAmount: number;    // Entero (en Créditos en Fase 1-2; en Token/Stable en Fase 3+)


  readonly currencyType: 'INTERNAL_CREDITS' | 'TESTNET_TOKEN' | 'STABLECOIN';


  readonly sellerCollateralAmount: number;


  readonly deadlineTick: number;


  readonly settlementState: 'AWAITING_DEPOSITS' | 'LOCKED' | 'RELEASED_TO_BUYER' | 'REFUNDED' | 'DISPUTED';


  readonly externalTxHash?: string;      // Hash de transacción en blockchain cuando aplique


}


________________


3. Máquina de Estados para Lotes Comerciales (CommodityLot)
Para evitar el doble gasto entre el servidor de juego y la blockchain en las Fases 3 y 4, toda transición sigue esta secuencia atómica:


[Inventario Libre: 1.500 Placas]


       │


       ├──► 1. createReservation(1.000 Placas)


       │    • Disponible pasa a 500; Reservado pasa a 1.000.


       │    • Se crea CommodityLot en estado RESERVED_OFF_CHAIN.


       ▼


[RESERVED_OFF_CHAIN]


       │


       ├──► 2A. Comercio Interno (Fase 1-2) ──► Se liquida contra INTERNAL_CREDITS en SQLite.


       │


       └──► 2B. Tokenización (Fase 3+) ──► Servidor firma autorización EIP-712 con nonce único.


                                           Estado pasa a TOKENIZED_RECEIPT.


                                                  │


                                                  ▼


                                            [IN_ESCROW] (TradeEscrow Smart Contract)


                                                  │


                                                  ├──► Comprador deposita pago y se ejecuta el swap.


                                                  ▼


                                       [SETTLED_PENDING_CLAIM]


                                                  │


                                                  ├──► SettlementAdapter espera N bloques de confirmación.


                                                  ├──► Acredita 1.000 Placas al comprador en SQLite.


                                                  ▼


                                         [CONSUMED_UNPACKED] (Recibo quemado e inválido para siempre)


________________


4. Contratos de Interfaz para Desacoplamiento (Adapters)
El motor del juego (SimulatorEngine) solo invoca estas interfaces. En la Fase 1 y 2 se inyecta SqliteLocalSettlementProvider; en la Fase 3 se inyecta EvmTestnetSettlementProvider:


export interface InventoryReservationService {


  lockMaterialsForLot(companyId: string, itemId: string, quantity: number, currentTick: number): Promise<CommodityLot>;


  unpackLotToInventory(lotId: string, receiverCompanyId: string, currentTick: number): Promise<void>;


  revertReservation(lotId: string, currentTick: number): Promise<void>;


}


export interface SettlementProvider {


  createEscrow(lot: CommodityLot, buyerCompanyId: string, price: number, deadlineTick: number): Promise<TradeEscrowRecord>;


  verifyAndSettleDelivery(escrowId: string, currentTick: number): Promise<{ settled: boolean; txReference: string }>;


  reconcileLedgerState(): Promise<{ discrepanciesFound: number; haltedLots: string[] }>;


}


________________


5. Controles de Seguridad del Oráculo y Reconciliación
1. Protección contra Replay en EIP-712: Toda firma emitida por el servidor autoritativo para permitir el mint o liberación de un lote incluye obligatoriamente: chainId, verifyingContract, lotId, companyId, nonce incremental por cuenta y expirationTimestamp.
2. Pausa Automática por Discrepancia (Circuit Breaker): El método reconcileLedgerState() se ejecuta periódicamente comparando la suma de materiales en RESERVED_OFF_CHAIN + TOKENIZED_RECEIPT contra los eventos emitidos por el contrato LotReceipt. Si existe una diferencia $\neq 0$, el adaptador congela el retiro/desempaquetado de lotes y emite una alerta crítica al operador sin detener el bucle principal de las fábricas.