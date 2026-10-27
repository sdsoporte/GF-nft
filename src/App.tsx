/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useTransition } from 'react';
import {
  Play,
  Pause,
  FastForward,
  RotateCcw,
  Factory,
  ScrollText,
  BookOpen,
  Cpu,
  Zap,
  Coins,
  ShieldCheck,
  TrendingUp,
  AlertTriangle,
  ArrowRight,
  Send,
  PlusCircle,
  KeyRound,
  Terminal,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Copy,
  Lock,
} from 'lucide-react';
import { SimulatorEngine } from './engine/SimulatorEngine.ts';
import { RECIPE_CATALOG, ITEM_IDS } from './domain/recipeCatalog.ts';
import {
  CompanyState,
  ItemId,
  RecipeId,
  SupplyContract,
  LinePriority,
} from './domain/types.ts';
import { McpGateway } from './mcp/McpGateway.ts';
import { McpGrant, McpResponse, McpToolName } from './mcp/types.ts';
import { SqliteLocalSettlementProvider } from './persistence/SqliteLocalSettlementProvider.ts';
import {
  CommodityLot,
  TradeEscrowRecord,
  Eip712LotVoucher,
} from './domain/web3DomainModel.ts';

export default function App() {
  const [, startTransition] = useTransition();
  const engineRef = useRef<SimulatorEngine | null>(null);
  const gatewayRef = useRef<McpGateway | null>(null);
  const settlementRef = useRef<SqliteLocalSettlementProvider | null>(null);

  // Initialize engine, gateway, and settlement provider once
  if (!engineRef.current) {
    const eng = new SimulatorEngine(42107);
    eng.initializeStandardMatch();
    engineRef.current = eng;

    const gw = new McpGateway(eng);
    // Seed initial grants
    gw.registerGrant({
      grantId: 'mcp_grant_99182',
      token: 'gf_mcp_metal01_live_token',
      playerId: 'usr_sergio_01',
      companyId: 'comp_metal_01',
      matchId: 'match_alpha_04',
      phaseMode: 'PHASE_1B_READ_WRITE',
      scopes: [
        'factory:read',
        'inventory:read',
        'market:read',
        'production:write',
        'logistics:write',
        'contracts:draft',
      ],
      resourceAllowlist: [
        'comp_metal_01_line_1',
        'comp_metal_01_line_2',
        'comp_metal_01_line_3',
      ],
      quotas: {
        maxReadPerMinute: 60,
        maxWritePerMinute: 12,
        maxWritePerMatch: 500,
      },
      createdAtUtc: new Date().toISOString(),
      expiresAtUtc: '2026-10-27T02:00:00Z',
      revoked: false,
    });

    gw.registerGrant({
      grantId: 'mcp_grant_88204',
      token: 'gf_mcp_manuf01_readonly_token',
      playerId: 'usr_elena_02',
      companyId: 'comp_manuf_01',
      matchId: 'match_alpha_04',
      phaseMode: 'PHASE_1_READ_ONLY',
      scopes: ['factory:read', 'inventory:read', 'market:read'],
      resourceAllowlist: [
        'comp_manuf_01_line_1',
        'comp_manuf_01_line_2',
        'comp_manuf_01_line_3',
      ],
      quotas: {
        maxReadPerMinute: 60,
        maxWritePerMinute: 12,
        maxWritePerMatch: 500,
      },
      createdAtUtc: new Date().toISOString(),
      expiresAtUtc: '2026-10-27T02:00:00Z',
      revoked: false,
    });

    gatewayRef.current = gw;

    const sp = new SqliteLocalSettlementProvider(eng);
    settlementRef.current = sp;
  }

  const engine = engineRef.current;
  const gateway = gatewayRef.current!;
  const settlement = settlementRef.current!;

  // React state reflecting engine snapshot
  const [currentTick, setCurrentTick] = useState<number>(engine.getCurrentTick());
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeedMs] = useState<number>(300); // ms per tick in UI
  const [companies, setCompanies] = useState<CompanyState[]>(engine.getAllCompanies());
  const [contracts, setContracts] = useState<SupplyContract[]>(engine.getAllContracts());
  const [globalProject, setGlobalProject] = useState(engine.getGlobalProject());
  const [stateHash, setStateHash] = useState<string>(engine.calculateStateHash());
  const [activeTab, setActiveTab] = useState<
    'factories' | 'recipes' | 'contracts' | 'mcp' | 'web3' | 'diagnostics'
  >('factories');
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('comp_metal_01');

  // Pre-Web3 & SQLite Ledger State
  const [lots, setLots] = useState<CommodityLot[]>(settlement.getAllLots());
  const [escrows, setEscrows] = useState<TradeEscrowRecord[]>(settlement.getAllEscrows());
  const [activeVoucher, setActiveVoucher] = useState<Eip712LotVoucher | null>(null);
  const [circuitBreakerStatus, setCircuitBreakerStatus] = useState<{
    isTripped: boolean;
    reason: string | null;
    discrepancies: number;
    haltedLots: string[];
  }>({
    isTripped: false,
    reason: null,
    discrepancies: 0,
    haltedLots: [],
  });

  const [lotForm, setLotForm] = useState({
    companyId: 'comp_metal_01',
    itemId: 'STEEL_PLATE' as ItemId,
    quantity: 20,
  });

  const [escrowParams, setEscrowParams] = useState({
    buyerId: 'comp_manuf_01',
    agreedPrice: 760,
    deadlineOffsetTicks: 400,
  });

  // MCP Playground State
  const [selectedGrantId, setSelectedGrantId] = useState<string>('mcp_grant_99182');
  const [selectedTool, setSelectedTool] = useState<McpToolName>('get_factory_overview');
  const getToolTemplate = (tool: McpToolName, companyId: string): string => {
    switch (tool) {
      case 'get_factory_overview':
      case 'get_inventory':
      case 'get_production_lines':
        return JSON.stringify({ company_id: companyId }, null, 2);
      case 'get_contracts':
        return JSON.stringify({ company_id: companyId, status: 'ACTIVE' }, null, 2);
      case 'get_market_quotes':
        return JSON.stringify({ item_id: 'STEEL_PLATE', limit: 10 }, null, 2);
      case 'get_action_history':
        return JSON.stringify({ company_id: companyId, last_n_ticks: 30 }, null, 2);
      case 'set_production_target':
        return JSON.stringify(
          {
            line_id: `${companyId}_line_1`,
            recipe_id: 'R1',
            target_batches: 5,
            idempotency_key: `mcp_target_${Date.now()}`,
          },
          null,
          2
        );
      case 'set_line_priority':
        return JSON.stringify(
          {
            line_id: `${companyId}_line_1`,
            priority: 1,
            idempotency_key: `mcp_prio_${Date.now()}`,
          },
          null,
          2
        );
      case 'pause_production_line':
        return JSON.stringify(
          {
            line_id: `${companyId}_line_1`,
            idempotency_key: `mcp_pause_${Date.now()}`,
          },
          null,
          2
        );
      case 'resume_production_line':
        return JSON.stringify(
          {
            line_id: `${companyId}_line_1`,
            idempotency_key: `mcp_resume_${Date.now()}`,
          },
          null,
          2
        );
      case 'schedule_internal_transport':
        return JSON.stringify(
          {
            contract_id: 'cnt_sample_01',
            quantity_to_ship: 10,
            idempotency_key: `mcp_ship_${Date.now()}`,
          },
          null,
          2
        );
      case 'draft_supply_offer':
        return JSON.stringify(
          {
            target_buyer_id: companyId === 'comp_metal_01' ? 'comp_manuf_01' : 'comp_metal_01',
            item_id: 'STEEL_PLATE',
            quantity: 20,
            unit_price: 38,
            deadline_ticks: 400,
            idempotency_key: `mcp_draft_${Date.now()}`,
          },
          null,
          2
        );
      case 'cancel_own_pending_offer':
        return JSON.stringify(
          {
            offer_id: 'cnt_sample_01',
            idempotency_key: `mcp_cancel_${Date.now()}`,
          },
          null,
          2
        );
    }
  };

  const [toolPayloadInput, setToolPayloadInput] = useState<string>(
    JSON.stringify({ company_id: 'comp_metal_01' }, null, 2)
  );
  const [mcpLastResponse, setMcpLastResponse] = useState<McpResponse | null>(null);
  const [mcpAuditLogs, setMcpAuditLogs] = useState(gateway.getAuditLogs());

  // Contract form state
  const [contractForm, setContractForm] = useState({
    sellerId: 'comp_metal_01',
    buyerId: 'comp_manuf_01',
    itemId: 'STEEL_PLATE' as ItemId,
    quantity: 20,
    unitPrice: 38,
    deadlineOffsetTicks: 400,
  });

  // Sync state from engine and settlement provider
  const syncState = () => {
    startTransition(() => {
      setCurrentTick(engine.getCurrentTick());
      setCompanies([...engine.getAllCompanies()]);
      setContracts([...engine.getAllContracts()]);
      setGlobalProject(engine.getGlobalProject());
      setStateHash(engine.calculateStateHash());
      setMcpAuditLogs([...gateway.getAuditLogs()]);
      setLots([...settlement.getAllLots()]);
      setEscrows([...settlement.getAllEscrows()]);
    });
  };

  // Pre-Web3 Action Handlers
  const handleCreateLot = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await settlement.lockMaterialsForLot(
        lotForm.companyId,
        lotForm.itemId,
        Number(lotForm.quantity),
        engine.getCurrentTick()
      );
      syncState();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTokenizeLot = (lotId: string) => {
    try {
      const voucher = settlement.generateEip712Voucher(lotId);
      setActiveVoucher(voucher);
      syncState();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevertLot = async (lotId: string) => {
    try {
      await settlement.revertReservation(lotId, engine.getCurrentTick());
      syncState();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOpenEscrow = async (lot: CommodityLot) => {
    try {
      await settlement.createEscrow(
        lot,
        escrowParams.buyerId,
        Number(escrowParams.agreedPrice),
        engine.getCurrentTick() + Number(escrowParams.deadlineOffsetTicks)
      );
      syncState();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSettleDelivery = async (escrowId: string) => {
    try {
      await settlement.verifyAndSettleDelivery(escrowId, engine.getCurrentTick());
      syncState();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRunReconciliation = async () => {
    const res = await settlement.reconcileLedgerState();
    setCircuitBreakerStatus({
      isTripped: res.isCircuitBreakerTripped,
      reason: settlement.getCircuitBreakerReason(),
      discrepancies: res.discrepanciesFound,
      haltedLots: res.haltedLots,
    });
    syncState();
  };

  const handleResetCircuitBreaker = () => {
    settlement.resetCircuitBreaker();
    setCircuitBreakerStatus({
      isTripped: false,
      reason: null,
      discrepancies: 0,
      haltedLots: [],
    });
    syncState();
  };

  // MCP Execution Handler
  const handleInvokeMcp = async () => {
    const currentGrant = gateway.getGrant(selectedGrantId);
    if (!currentGrant) return;
    try {
      const parsedParams = JSON.parse(toolPayloadInput);
      const resp = await gateway.invokeTool(currentGrant.token, selectedTool, parsedParams);
      setMcpLastResponse(resp);
      syncState();
    } catch (err: unknown) {
      setMcpLastResponse({
        success: false,
        tick: engine.getCurrentTick(),
        tool: selectedTool,
        errorCode: 'ERR_INVALID_PAYLOAD',
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: 1,
      });
    }
  };

  const handleToolChange = (newTool: McpToolName) => {
    setSelectedTool(newTool);
    const grant = gateway.getGrant(selectedGrantId);
    if (grant) {
      setToolPayloadInput(getToolTemplate(newTool, grant.companyId));
    }
  };

  const handleGrantChange = (grantId: string) => {
    setSelectedGrantId(grantId);
    const grant = gateway.getGrant(grantId);
    if (grant) {
      setToolPayloadInput(getToolTemplate(selectedTool, grant.companyId));
    }
  };

  const handleToggleRevokeGrant = (grantId: string) => {
    const grant = gateway.getGrant(grantId);
    if (!grant) return;
    grant.revoked = !grant.revoked;
    syncState();
  };

  const handleTogglePhaseMode = (grantId: string) => {
    const grant = gateway.getGrant(grantId);
    if (!grant) return;
    grant.phaseMode =
      grant.phaseMode === 'PHASE_1_READ_ONLY' ? 'PHASE_1B_READ_WRITE' : 'PHASE_1_READ_ONLY';
    syncState();
  };

  // Tick execution
  const handleStepTick = (count: number = 1) => {
    for (let i = 0; i < count; i++) {
      if (engine.getCurrentTick() >= SimulatorEngine.MATCH_TOTAL_TICKS) {
        setIsPlaying(false);
        break;
      }
      engine.processTick();
    }
    syncState();
  };

  const handleReset = (seed: number = 42107) => {
    setIsPlaying(false);
    engineRef.current = new SimulatorEngine(seed);
    engineRef.current.initializeStandardMatch();
    syncState();
  };

  // Play loop
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      if (engine.getCurrentTick() >= SimulatorEngine.MATCH_TOTAL_TICKS) {
        setIsPlaying(false);
        return;
      }
      engine.processTick();
      syncState();
    }, playbackSpeedMs);

    return () => clearInterval(interval);
  }, [isPlaying, playbackSpeedMs]);

  // Production Line Action Handlers
  const handleSetProduction = (lineId: string, recipeId: RecipeId, targetBatches: number) => {
    const success = engine.submitCommand({
      commandId: `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      companyId: selectedCompanyId,
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: `set_target_${lineId}_${engine.getCurrentTick()}_${Math.random()}`,
      type: 'SET_PRODUCTION_TARGET',
      lineId,
      recipeId,
      targetBatches,
    });
    if (success) syncState();
  };

  const handleSetPriority = (lineId: string, priority: LinePriority) => {
    const success = engine.submitCommand({
      commandId: `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      companyId: selectedCompanyId,
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: `prio_${lineId}_${engine.getCurrentTick()}_${Math.random()}`,
      type: 'SET_LINE_PRIORITY',
      lineId,
      priority,
    });
    if (success) syncState();
  };

  const handleTogglePause = (lineId: string, isPaused: boolean) => {
    const success = engine.submitCommand({
      commandId: `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      companyId: selectedCompanyId,
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: `toggle_${lineId}_${engine.getCurrentTick()}_${Math.random()}`,
      type: isPaused ? 'RESUME_PRODUCTION_LINE' : 'PAUSE_PRODUCTION_LINE',
      lineId,
    });
    if (success) syncState();
  };

  // Contract actions
  const handleCreateContract = (e: React.FormEvent) => {
    e.preventDefault();
    const deadlineTicks = engine.getCurrentTick() + Number(contractForm.deadlineOffsetTicks);
    const success = engine.submitCommand({
      commandId: `cmd_contract_${Date.now()}`,
      companyId: contractForm.sellerId,
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: `create_contract_${contractForm.sellerId}_${engine.getCurrentTick()}_${Math.random()}`,
      type: 'CREATE_SUPPLY_OFFER',
      targetBuyerId: contractForm.buyerId,
      itemId: contractForm.itemId,
      quantity: Number(contractForm.quantity),
      unitPriceCredits: Number(contractForm.unitPrice),
      deadlineTicks,
    });
    if (success) {
      handleStepTick(1);
    }
  };

  const handleAcceptContract = (contractId: string, buyerId: string) => {
    engine.submitCommand({
      commandId: `cmd_accept_${contractId}`,
      companyId: buyerId,
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: `accept_${contractId}_${engine.getCurrentTick()}`,
      type: 'ACCEPT_SUPPLY_OFFER',
      contractId,
    });
    handleStepTick(1);
  };

  const handleShipContract = (contractId: string, sellerId: string, qty: number) => {
    engine.submitCommand({
      commandId: `cmd_ship_${contractId}_${Date.now()}`,
      companyId: sellerId,
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: `ship_${contractId}_${engine.getCurrentTick()}_${Math.random()}`,
      type: 'SCHEDULE_INTERNAL_TRANSPORT',
      contractId,
      quantityToShip: qty,
    });
    handleStepTick(1);
  };

  const handleInstallTurbine = (companyId: string) => {
    engine.submitCommand({
      commandId: `cmd_turbine_${Date.now()}`,
      companyId,
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: `install_turbine_${companyId}_${engine.getCurrentTick()}`,
      type: 'INSTALL_TURBINE_EXPANSION',
    });
    handleStepTick(1);
  };

  const handleDeliverMegamachine = (companyId: string, quantity: number = 1) => {
    engine.submitCommand({
      commandId: `cmd_megamachine_${Date.now()}`,
      companyId,
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: `deliver_r8_${companyId}_${engine.getCurrentTick()}`,
      type: 'DELIVER_MEGAMACHINE_PART',
      quantity,
    });
    handleStepTick(1);
  };

  const selectedCompany = companies.find((c) => c.companyId === selectedCompanyId) || companies[0];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-amber-500/30">
      {/* Top Authoritative Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-30 px-5 py-3">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 font-bold text-lg shadow-inner">
              GF
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-base tracking-wide text-slate-100 uppercase">
                  GigaForge v4.1
                </h1>
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  Authoritative Core
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                  Seed: 42107
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Discrete-Tick Off-Chain Engine • Pure Integer Arithmetic
              </p>
            </div>
          </div>

          {/* Tick Counter & Match Progress */}
          <div className="flex items-center gap-4 bg-slate-950/80 px-4 py-1.5 rounded-lg border border-slate-800">
            <div className="text-right">
              <div className="text-[10px] uppercase font-mono text-slate-500">Current Tick</div>
              <div className="text-base font-mono font-bold text-amber-400">
                {currentTick} <span className="text-slate-600 font-normal">/ 2700</span>
              </div>
            </div>
            <div className="w-px h-7 bg-slate-800" />
            <div className="text-right">
              <div className="text-[10px] uppercase font-mono text-slate-500">Match Time</div>
              <div className="text-sm font-mono text-slate-300">
                {Math.floor(currentTick / 60)}m {currentTick % 60}s
              </div>
            </div>
            <div className="w-px h-7 bg-slate-800" />
            <div className="text-right">
              <div className="text-[10px] uppercase font-mono text-slate-500">Global R8 Project</div>
              <div className="text-sm font-mono font-semibold text-cyan-400">
                {globalProject.deliveredMegamachineParts} / {globalProject.requiredMegamachineParts}
              </div>
            </div>
          </div>

          {/* Simulation Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                isPlaying
                  ? 'bg-amber-600 hover:bg-amber-500 text-slate-950'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {isPlaying ? 'Pause' : 'Run Simulation'}
            </button>

            <button
              onClick={() => handleStepTick(1)}
              disabled={isPlaying || currentTick >= 2700}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 rounded-md text-xs font-mono font-semibold"
              title="Step 1 tick (1 second)"
            >
              +1 Tick
            </button>

            <button
              onClick={() => handleStepTick(50)}
              disabled={isPlaying || currentTick >= 2700}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 rounded-md text-xs font-mono font-semibold"
              title="Fast forward 50 ticks"
            >
              <FastForward className="w-3 h-3" /> +50
            </button>

            <button
              onClick={() => handleReset(42107)}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded-md transition"
              title="Reset match to Tick 0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="max-w-7xl mx-auto flex items-center gap-6 mt-3 pt-2 border-t border-slate-800/60 text-xs font-medium">
          <button
            onClick={() => setActiveTab('factories')}
            className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
              activeTab === 'factories'
                ? 'border-amber-400 text-amber-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Factory className="w-3.5 h-3.5" />
            Factory Lines & Companies
          </button>
          <button
            onClick={() => setActiveTab('contracts')}
            className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
              activeTab === 'contracts'
                ? 'border-amber-400 text-amber-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <ScrollText className="w-3.5 h-3.5" />
            B2B Contracts ({contracts.length})
          </button>
          <button
            onClick={() => setActiveTab('recipes')}
            className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
              activeTab === 'recipes'
                ? 'border-amber-400 text-amber-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            Recipe Catalog (R1–R8)
          </button>
          <button
            onClick={() => setActiveTab('mcp')}
            className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
              activeTab === 'mcp'
                ? 'border-amber-400 text-amber-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <KeyRound className="w-3.5 h-3.5" />
            MCP Gateway & Agents ({gateway.getAllGrants().length})
          </button>
          <button
            onClick={() => setActiveTab('web3')}
            className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
              activeTab === 'web3'
                ? 'border-amber-400 text-amber-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Lock className="w-3.5 h-3.5" />
            Pre-Web3 Escrow & Lots ({lots.length})
          </button>
          <button
            onClick={() => setActiveTab('diagnostics')}
            className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
              activeTab === 'diagnostics'
                ? 'border-amber-400 text-amber-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            Engine Diagnostics & Replay Hash
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto w-full p-5 flex-1 space-y-6">
        {/* Global Scenario Banner */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-cyan-950 border border-cyan-800/60 flex items-center justify-center text-cyan-400">
              <TrendingUp className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm text-slate-100">
                  Global Project: Central Megamachine Assembler (R8)
                </h3>
                {globalProject.isVictorious && (
                  <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded font-mono font-bold">
                    VICTORY ACHIEVED
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">
                Requires 12 MEGAMACHINE_PART before Tick 2,700 for sector survival.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 min-w-[280px]">
            <div className="flex-1">
              <div className="flex justify-between text-xs font-mono mb-1">
                <span className="text-slate-400">Progress</span>
                <span className="text-cyan-400 font-bold">
                  {globalProject.deliveredMegamachineParts} / {globalProject.requiredMegamachineParts}{' '}
                  ({Math.floor((globalProject.deliveredMegamachineParts / 12) * 100)}%)
                </span>
              </div>
              <div className="w-full bg-slate-950 h-2.5 rounded-full overflow-hidden border border-slate-800">
                <div
                  className="bg-cyan-500 h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.min(
                      100,
                      (globalProject.deliveredMegamachineParts / 12) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* TAB 1: FACTORIES & COMPANIES */}
        {activeTab === 'factories' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Company Selector Sidebar */}
            <div className="lg:col-span-1 space-y-3">
              <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400">
                Active Enterprises (4)
              </h3>
              {companies.map((comp) => {
                const nw = engine.calculateNetWorth(comp.companyId);
                const isSelected = comp.companyId === selectedCompanyId;
                return (
                  <div
                    key={comp.companyId}
                    onClick={() => setSelectedCompanyId(comp.companyId)}
                    className={`cursor-pointer rounded-xl p-3.5 border transition ${
                      isSelected
                        ? 'bg-slate-800 border-amber-500/60 shadow-md ring-1 ring-amber-500/40'
                        : 'bg-slate-900 border-slate-800 hover:border-slate-700 hover:bg-slate-850'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-semibold text-sm text-slate-100 flex items-center gap-1.5">
                          {comp.name}
                          {comp.isNPC && (
                            <span className="text-[9px] bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded font-mono">
                              NPC
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                          {comp.industrialClass === 'CLASS_A_METALLURGY'
                            ? 'Class A • Metallurgy'
                            : 'Class B • Assembly & Logistics'}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mt-3 pt-2.5 border-t border-slate-800/80 text-xs">
                      <div>
                        <div className="text-[10px] text-slate-500">NetWorth</div>
                        <div className="font-mono font-bold text-amber-400">
                          {nw.netWorth.toLocaleString()} Cr
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-500">CREDITS</div>
                        <div className="font-mono text-slate-200">
                          {comp.credits.toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Selected Company Factory Operations Panel */}
            <div className="lg:col-span-3 space-y-6">
              {/* Company Metrics Header */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-bold text-slate-100">{selectedCompany.name}</h2>
                      <span
                        className={`text-xs px-2.5 py-0.5 rounded-full font-mono font-medium ${
                          selectedCompany.industrialClass === 'CLASS_A_METALLURGY'
                            ? 'bg-orange-500/10 border border-orange-500/30 text-orange-400'
                            : 'bg-blue-500/10 border border-blue-500/30 text-blue-400'
                        }`}
                      >
                        {selectedCompany.industrialClass}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {selectedCompany.industrialClass === 'CLASS_A_METALLURGY'
                        ? 'Optimal recipes: R1, R2, R3 (Furnaces). Outside recipes penalized +100% time & energy.'
                        : 'Optimal recipes: R4, R5, R6 (Assembly). Free transport energy.'}
                    </p>
                  </div>

                  {/* Actions for R7 & R8 */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleInstallTurbine(selectedCompany.companyId)}
                      disabled={
                        currentTick < SimulatorEngine.TURBINE_EXPANSION_UNLOCK_TICK ||
                        selectedCompany.inventory.IND_TURBINE.available < 1
                      }
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs rounded-md font-medium text-slate-200 border border-slate-700 transition"
                      title={
                        currentTick < 900
                          ? 'Unlocks at Tick 900. Consumes 1 IND_TURBINE for +15 energy/tick and +1 line.'
                          : 'Expand electric grid and factory line'
                      }
                    >
                      Install R7 Turbine ({selectedCompany.installedTurbinesR7})
                    </button>

                    <button
                      onClick={() => handleDeliverMegamachine(selectedCompany.companyId, 1)}
                      disabled={selectedCompany.inventory.MEGAMACHINE_PART.available < 1}
                      className="px-3 py-1.5 bg-cyan-950 hover:bg-cyan-900 border border-cyan-800 text-cyan-300 disabled:opacity-40 text-xs rounded-md font-medium transition"
                      title="Deliver 1 MEGAMACHINE_PART to Central Assembler (+6,000 NetWorth)"
                    >
                      Contribute R8 Part ({selectedCompany.contributedMegamachinePartsR8})
                    </button>
                  </div>
                </div>

                {/* Resource Stats Bar */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-950/70 p-3.5 rounded-lg border border-slate-800 text-xs">
                  <div className="flex items-center gap-2.5">
                    <Coins className="w-4 h-4 text-amber-400 shrink-0" />
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase font-mono">Credits</div>
                      <div className="font-mono font-bold text-amber-400 text-sm">
                        {selectedCompany.credits.toLocaleString()} Cr
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <Zap className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase font-mono">
                        Energy Storage
                      </div>
                      <div className="font-mono font-semibold text-emerald-400 text-sm">
                        {selectedCompany.energy} / {selectedCompany.maxEnergyStorage}{' '}
                        <span className="text-[10px] text-emerald-500">
                          (+{selectedCompany.energyGenerationPerTick}/t)
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0" />
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase font-mono">
                        Reputation
                      </div>
                      <div className="font-mono font-semibold text-blue-400 text-sm">
                        {selectedCompany.reputation} pts
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <TrendingUp className="w-4 h-4 text-purple-400 shrink-0" />
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase font-mono">
                        Total NetWorth
                      </div>
                      <div className="font-mono font-bold text-purple-400 text-sm">
                        {engine.calculateNetWorth(selectedCompany.companyId).netWorth.toLocaleString()}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Inventory Grid */}
                <div className="mt-4">
                  <div className="text-xs font-mono uppercase text-slate-400 mb-2">
                    Factory Inventory Stocks
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-2">
                    {(Object.keys(selectedCompany.inventory) as ItemId[]).map((itemId) => {
                      const stock = selectedCompany.inventory[itemId];
                      return (
                        <div
                          key={itemId}
                          className="bg-slate-950 p-2 rounded border border-slate-800 text-center"
                        >
                          <div className="text-[9px] font-mono text-slate-500 truncate" title={itemId}>
                            {itemId.replace('_', ' ')}
                          </div>
                          <div className="text-xs font-mono font-bold text-slate-200 mt-1">
                            {stock.available}
                          </div>
                          {stock.reserved > 0 && (
                            <div className="text-[9px] font-mono text-amber-500/80">
                              +{stock.reserved} res
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Production Lines Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                    <Factory className="w-4 h-4 text-amber-400" />
                    Industrial Production Lines ({selectedCompany.lines.length})
                  </h3>
                  <span className="text-xs text-slate-400 font-mono">
                    Maintenance: 100 Cr / active line every 300 ticks
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {selectedCompany.lines.map((line) => {
                    const batch = line.activeBatch;
                    const progressPercent = batch
                      ? Math.min(100, Math.floor((batch.progressTicks / batch.totalDurationTicks) * 100))
                      : 0;

                    return (
                      <div
                        key={line.lineId}
                        className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-3"
                      >
                        <div>
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-xs font-bold text-slate-300">
                              {line.lineId.split('_').slice(-2).join(' ').toUpperCase()}
                            </span>
                            <div className="flex items-center gap-1.5">
                              {/* Priority Selector */}
                              <div className="flex items-center bg-slate-950 rounded border border-slate-800 p-0.5 text-[10px] font-mono">
                                {[1, 2, 3].map((p) => (
                                  <button
                                    key={p}
                                    onClick={() => handleSetPriority(line.lineId, p as LinePriority)}
                                    className={`px-1.5 py-0.5 rounded ${
                                      line.priority === p
                                        ? 'bg-amber-500 text-slate-950 font-bold'
                                        : 'text-slate-400 hover:text-slate-200'
                                    }`}
                                  >
                                    P{p}
                                  </button>
                                ))}
                              </div>

                              {/* Status Badge */}
                              <span
                                className={`text-[9px] px-2 py-0.5 rounded font-mono font-bold ${
                                  line.status === 'RUNNING'
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : line.status === 'NO_ENERGY'
                                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                    : line.status === 'PAUSED'
                                    ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                    : 'bg-slate-800 text-slate-400'
                                }`}
                              >
                                {line.status}
                              </span>
                            </div>
                          </div>

                          {/* Active Recipe Details */}
                          <div className="mt-3 bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
                            {batch ? (
                              <div>
                                <div className="flex justify-between items-center text-xs">
                                  <span className="font-semibold text-amber-400">
                                    {batch.recipeId}: {RECIPE_CATALOG[batch.recipeId].name}
                                  </span>
                                  <span className="font-mono text-slate-400 text-[10px]">
                                    Batch {batch.completedBatches + 1} / {batch.targetBatches}
                                  </span>
                                </div>

                                <div className="mt-2">
                                  <div className="flex justify-between text-[10px] font-mono text-slate-500 mb-1">
                                    <span>Progress</span>
                                    <span>
                                      {batch.progressTicks} / {batch.totalDurationTicks} t (
                                      {progressPercent}%)
                                    </span>
                                  </div>
                                  <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
                                    <div
                                      className="bg-amber-500 h-full rounded-full transition-all duration-300"
                                      style={{ width: `${progressPercent}%` }}
                                    />
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="text-center py-2 text-xs text-slate-500 font-mono">
                                Line is currently IDLE
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Line Actions */}
                        <div className="pt-2 border-t border-slate-800 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1">
                            <select
                              id={`select_${line.lineId}`}
                              defaultValue={line.currentRecipeId || 'R1'}
                              className="bg-slate-950 border border-slate-800 text-xs rounded px-2 py-1 text-slate-300 font-mono"
                            >
                              {(Object.keys(RECIPE_CATALOG) as RecipeId[]).map((rid) => (
                                <option key={rid} value={rid}>
                                  {rid} - {RECIPE_CATALOG[rid].outputItem}
                                </option>
                              ))}
                            </select>

                            <button
                              onClick={() => {
                                const select = document.getElementById(
                                  `select_${line.lineId}`
                                ) as HTMLSelectElement;
                                if (select) {
                                  handleSetProduction(line.lineId, select.value as RecipeId, 5);
                                }
                              }}
                              className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded text-xs transition"
                            >
                              Start
                            </button>
                          </div>

                          {batch && (
                            <button
                              onClick={() => handleTogglePause(line.lineId, line.status === 'PAUSED')}
                              className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs transition"
                            >
                              {line.status === 'PAUSED' ? 'Resume' : 'Pause'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: RECIPE CATALOG (R1 - R8 MATRIX) */}
        {activeTab === 'recipes' && (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-amber-400" />
                Master Production Tree & Asymmetric Recipe Catalog
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Class A (Metallurgy) specializes in R1–R3. Class B (Manufacturing) specializes in
                R4–R6. Notice the +100% time and +80% to +128% energy penalty when operating out of
                specialization.
              </p>
            </div>

            <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-900">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950 text-slate-400 font-mono uppercase text-[10px] border-b border-slate-800">
                  <tr>
                    <th className="p-3">ID</th>
                    <th className="p-3">Product Name</th>
                    <th className="p-3">Inputs Required</th>
                    <th className="p-3">Output</th>
                    <th className="p-3">Class A (Time / Energy)</th>
                    <th className="p-3">Class B (Time / Energy)</th>
                    <th className="p-3">Est. Base Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {(Object.keys(RECIPE_CATALOG) as RecipeId[]).map((rId) => {
                    const r = RECIPE_CATALOG[rId];
                    const isClassAOptimal = r.classA.durationTicks < r.classB.durationTicks;
                    const isClassBOptimal = r.classB.durationTicks < r.classA.durationTicks;

                    return (
                      <tr key={rId} className="hover:bg-slate-850/50 transition">
                        <td className="p-3 font-bold text-amber-400">{r.id}</td>
                        <td className="p-3 font-semibold text-slate-200">{r.name}</td>
                        <td className="p-3 text-slate-400">
                          {r.inputs.map((inp) => `${inp.quantity} ${inp.itemId}`).join(' + ')}
                        </td>
                        <td className="p-3 text-emerald-400 font-semibold">
                          +{r.outputQuantity} {r.outputItem}
                        </td>
                        <td className="p-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] ${
                              isClassAOptimal
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : isClassBOptimal
                                ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                : 'bg-slate-800 text-slate-300'
                            }`}
                          >
                            {r.classA.durationTicks}t / {r.classA.energyCost}E{' '}
                            {isClassAOptimal ? '(Optimal)' : isClassBOptimal ? '(Penalized)' : ''}
                          </span>
                        </td>
                        <td className="p-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] ${
                              isClassBOptimal
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : isClassAOptimal
                                ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                : 'bg-slate-800 text-slate-300'
                            }`}
                          >
                            {r.classB.durationTicks}t / {r.classB.energyCost}E{' '}
                            {isClassBOptimal ? '(Optimal)' : isClassAOptimal ? '(Penalized)' : ''}
                          </span>
                        </td>
                        <td className="p-3 text-amber-400 font-bold">
                          {r.estimatedBaseCostCredits} Cr
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 3: B2B CONTRACTS & ESCROW */}
        {activeTab === 'contracts' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Create Contract Offer Form */}
            <div className="lg:col-span-1 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <PlusCircle className="w-5 h-5 text-amber-400" />
                <h3 className="font-bold text-sm text-slate-100">Draft B2B Supply Contract</h3>
              </div>
              <p className="text-xs text-slate-400">
                Supply contracts require 20% collateral from the seller and 100% credit escrow from the
                buyer.
              </p>

              <form onSubmit={handleCreateContract} className="space-y-3 text-xs">
                <div>
                  <label className="text-slate-400 block mb-1">Seller (Supplier)</label>
                  <select
                    value={contractForm.sellerId}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, sellerId: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
                  >
                    {companies.map((c) => (
                      <option key={c.companyId} value={c.companyId}>
                        {c.name} ({c.industrialClass})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-slate-400 block mb-1">Buyer (Client)</label>
                  <select
                    value={contractForm.buyerId}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, buyerId: e.target.value })
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
                  >
                    {companies.map((c) => (
                      <option key={c.companyId} value={c.companyId}>
                        {c.name} ({c.industrialClass})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-slate-400 block mb-1">Material / Item</label>
                  <select
                    value={contractForm.itemId}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, itemId: e.target.value as ItemId })
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
                  >
                    {(Object.keys(ITEM_IDS) as ItemId[]).map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-slate-400 block mb-1">Quantity</label>
                    <input
                      type="number"
                      min="1"
                      value={contractForm.quantity}
                      onChange={(e) =>
                        setContractForm({ ...contractForm, quantity: Number(e.target.value) })
                      }
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-slate-400 block mb-1">Unit Price (Cr)</label>
                    <input
                      type="number"
                      min="1"
                      value={contractForm.unitPrice}
                      onChange={(e) =>
                        setContractForm({ ...contractForm, unitPrice: Number(e.target.value) })
                      }
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-slate-400 block mb-1">Deadline Duration (Ticks)</label>
                  <input
                    type="number"
                    min="50"
                    step="50"
                    value={contractForm.deadlineOffsetTicks}
                    onChange={(e) =>
                      setContractForm({
                        ...contractForm,
                        deadlineOffsetTicks: Number(e.target.value),
                      })
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                  />
                </div>

                {/* Economic Summary */}
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-1 font-mono text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Total Contract Value:</span>
                    <span className="text-amber-400 font-bold">
                      {(contractForm.quantity * contractForm.unitPrice).toLocaleString()} Cr
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Seller Collateral (20%):</span>
                    <span className="text-rose-400 font-semibold">
                      {Math.floor(
                        (contractForm.quantity * contractForm.unitPrice * 20) / 100
                      ).toLocaleString()}{' '}
                      Cr
                    </span>
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg transition"
                >
                  Publish Contract Offer
                </button>
              </form>
            </div>

            {/* Contracts Ledger */}
            <div className="lg:col-span-2 space-y-3">
              <h3 className="font-bold text-sm text-slate-100 flex items-center justify-between">
                <span>Active & Settled Contracts Ledger ({contracts.length})</span>
                <span className="text-xs text-slate-400 font-mono">Market Fee: 2% burned</span>
              </h3>

              {contracts.length === 0 ? (
                <div className="p-8 text-center text-slate-500 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono">
                  No B2B contracts registered yet. Use the draft form to publish one.
                </div>
              ) : (
                <div className="space-y-3">
                  {contracts.map((cnt) => {
                    const seller = companies.find((c) => c.companyId === cnt.sellerCompanyId);
                    const buyer = companies.find((c) => c.companyId === cnt.buyerCompanyId);

                    return (
                      <div
                        key={cnt.contractId}
                        className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs space-y-2.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-bold text-slate-300">
                            {cnt.contractId}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded font-mono font-bold text-[10px] ${
                              cnt.status === 'ACTIVE'
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                : cnt.status === 'FULFILLED'
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : cnt.status === 'DEFAULTED'
                                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {cnt.status}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 font-mono text-slate-300">
                          <span className="text-amber-400 font-semibold">{seller?.name}</span>
                          <ArrowRight className="w-3.5 h-3.5 text-slate-600" />
                          <span className="text-cyan-400 font-semibold">{buyer?.name}</span>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-950 p-2.5 rounded border border-slate-800 font-mono text-[11px]">
                          <div>
                            <span className="text-slate-500 block text-[9px]">Item / Qty</span>
                            <span className="font-bold text-slate-200">
                              {cnt.totalQuantity} {cnt.itemId}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 block text-[9px]">Delivered</span>
                            <span className="font-bold text-emerald-400">
                              {cnt.deliveredQuantity} / {cnt.totalQuantity}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 block text-[9px]">Value</span>
                            <span className="font-bold text-amber-400">
                              {cnt.totalValueCredits} Cr
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 block text-[9px]">Deadline</span>
                            <span className="font-bold text-slate-300">Tick {cnt.deadlineTick}</span>
                          </div>
                        </div>

                        {/* Contract Actions */}
                        {cnt.status === 'PENDING' && (
                          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                            <button
                              onClick={() => handleAcceptContract(cnt.contractId, cnt.buyerCompanyId)}
                              className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded text-xs transition"
                            >
                              Accept Contract (Lock {cnt.totalValueCredits} Cr)
                            </button>
                          </div>
                        )}

                        {cnt.status === 'ACTIVE' && cnt.deliveredQuantity < cnt.totalQuantity && (
                          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800">
                            <span className="text-[10px] text-slate-400 font-mono">
                              Dispatch material from {seller?.name}
                            </span>
                            <button
                              onClick={() =>
                                handleShipContract(
                                  cnt.contractId,
                                  cnt.sellerCompanyId,
                                  cnt.totalQuantity - cnt.deliveredQuantity
                                )
                              }
                              className="flex items-center gap-1 px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded text-xs transition"
                            >
                              <Send className="w-3 h-3" />
                              Ship Batch ({cnt.totalQuantity - cnt.deliveredQuantity} units)
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB: MCP GATEWAY & AGENT API */}
        {activeTab === 'mcp' && (
          <div className="space-y-6">
            {/* Header info */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                    <Terminal className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                      Stateless MCP Gateway (Spec 2026-07-28)
                    </h2>
                    <p className="text-xs text-slate-400">
                      Open interface for external scripts and LLMs. GigaForge pays 0 external inference.
                      All write commands are queued authoritatively for the next tick.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-[10px] font-mono">
                  <span className="px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-slate-300">
                    Bearer Token: gf_mcp_*
                  </span>
                  <span className="px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-cyan-400">
                    Prompt Injection Immune
                  </span>
                </div>
              </div>
            </div>

            {/* MCP Grants & Panic Switch Section */}
            <div className="space-y-3">
              <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                Active MCP Grants & Policy Controls ({gateway.getAllGrants().length})
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {gateway.getAllGrants().map((grant) => (
                  <div
                    key={grant.grantId}
                    className={`bg-slate-900 rounded-xl p-4 border transition ${
                      grant.revoked
                        ? 'border-rose-900/60 bg-rose-950/10'
                        : grant.grantId === selectedGrantId
                        ? 'border-emerald-500/60 ring-1 ring-emerald-500/40'
                        : 'border-slate-800'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-slate-200">
                            {grant.grantId}
                          </span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-amber-400">
                            {grant.companyId}
                          </span>
                          {grant.revoked ? (
                            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30">
                              REVOKED
                            </span>
                          ) : (
                            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                              ACTIVE
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-slate-400 mt-1 flex items-center gap-2">
                          <span className="text-slate-500">Token:</span>
                          <code className="text-slate-300 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">
                            {grant.token}
                          </code>
                        </div>
                      </div>

                      {/* Panic Switch */}
                      <button
                        onClick={() => handleToggleRevokeGrant(grant.grantId)}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-mono font-bold transition ${
                          grant.revoked
                            ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                            : 'bg-rose-600 hover:bg-rose-500 text-white shadow-sm'
                        }`}
                        title={
                          grant.revoked
                            ? 'Restore agent access'
                            : 'Emergency Panic Button: Immediately revokes token and triggers ERR_AUTH_REVOKED'
                        }
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        {grant.revoked ? 'Restore' : 'Panic Disconnect'}
                      </button>
                    </div>

                    {/* Phase Mode Toggle */}
                    <div className="mt-3 pt-3 border-t border-slate-800 flex items-center justify-between text-xs font-mono">
                      <span className="text-slate-400">Phase Mode:</span>
                      <button
                        onClick={() => handleTogglePhaseMode(grant.grantId)}
                        className={`px-2 py-0.5 rounded font-bold transition text-[10px] ${
                          grant.phaseMode === 'PHASE_1B_READ_WRITE'
                            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        }`}
                      >
                        {grant.phaseMode} (Click to toggle)
                      </button>
                    </div>

                    {/* Allowlist & Scopes */}
                    <div className="mt-2 space-y-1.5 text-[10px] font-mono">
                      <div>
                        <span className="text-slate-500 block">Allowed Production Lines:</span>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {grant.resourceAllowlist.map((line) => (
                            <span
                              key={line}
                              className="px-1.5 py-0.2 rounded bg-slate-950 border border-slate-800 text-slate-300"
                            >
                              {line.split('_').slice(-2).join('_')}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div>
                        <span className="text-slate-500 block">Authorized Scopes:</span>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {grant.scopes.map((scope) => (
                            <span
                              key={scope}
                              className="px-1.5 py-0.2 rounded bg-slate-950 border border-slate-800 text-emerald-400"
                            >
                              {scope}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="flex justify-between pt-1 text-slate-500">
                        <span>Quotas:</span>
                        <span>
                          {grant.quotas.maxReadPerMinute} reads/m • {grant.quotas.maxWritePerMinute}{' '}
                          writes/m
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Interactive MCP Client & Tool Playground */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left Column: Request Builder */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-emerald-400" />
                    MCP Tool Request Sandbox
                  </h3>
                  <span className="text-[10px] font-mono text-slate-400">
                    JSON-RPC / Tool Dispatch
                  </span>
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <label className="text-slate-400 block mb-1">Target Identity / Grant</label>
                    <select
                      value={selectedGrantId}
                      onChange={(e) => handleGrantChange(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                    >
                      {gateway.getAllGrants().map((g) => (
                        <option key={g.grantId} value={g.grantId}>
                          {g.grantId} ({g.companyId} - {g.phaseMode})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-slate-400 block mb-1">MCP Tool Function</label>
                    <select
                      value={selectedTool}
                      onChange={(e) => handleToolChange(e.target.value as McpToolName)}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                    >
                      <optgroup label="Read Tools (Fase 1 / 1B)">
                        <option value="get_factory_overview">get_factory_overview (factory:read)</option>
                        <option value="get_inventory">get_inventory (inventory:read)</option>
                        <option value="get_production_lines">get_production_lines (factory:read)</option>
                        <option value="get_contracts">get_contracts (market:read)</option>
                        <option value="get_market_quotes">get_market_quotes (market:read)</option>
                        <option value="get_action_history">get_action_history (factory:read)</option>
                      </optgroup>
                      <optgroup label="Write Tools (Fase 1B)">
                        <option value="set_production_target">set_production_target (production:write)</option>
                        <option value="set_line_priority">set_line_priority (production:write)</option>
                        <option value="pause_production_line">pause_production_line (production:write)</option>
                        <option value="resume_production_line">resume_production_line (production:write)</option>
                        <option value="schedule_internal_transport">schedule_internal_transport (logistics:write)</option>
                        <option value="draft_supply_offer">draft_supply_offer (contracts:draft)</option>
                        <option value="cancel_own_pending_offer">cancel_own_pending_offer (contracts:draft)</option>
                      </optgroup>
                    </select>
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="text-slate-400">JSON Input Parameters</label>
                      <button
                        onClick={() => {
                          const grant = gateway.getGrant(selectedGrantId);
                          if (grant) setToolPayloadInput(getToolTemplate(selectedTool, grant.companyId));
                        }}
                        className="text-[10px] text-amber-400 hover:underline font-mono"
                      >
                        Reset Template
                      </button>
                    </div>
                    <textarea
                      rows={7}
                      value={toolPayloadInput}
                      onChange={(e) => setToolPayloadInput(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded p-2.5 text-slate-200 font-mono text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                    />
                  </div>

                  <button
                    onClick={handleInvokeMcp}
                    className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg transition flex items-center justify-center gap-2"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Invoke MCP Tool
                  </button>
                </div>
              </div>

              {/* Right Column: Live Response & Latency Inspector */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-cyan-400" />
                      Live Response Inspector
                    </h3>
                    {mcpLastResponse && (
                      <div className="flex items-center gap-2 font-mono text-xs">
                        <span
                          className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                            mcpLastResponse.success
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                          }`}
                        >
                          {mcpLastResponse.success
                            ? '200 SUCCESS'
                            : (mcpLastResponse as any).errorCode}
                        </span>
                        <span className="text-slate-400 text-[10px]">
                          {mcpLastResponse.latencyMs} ms
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 max-h-96 overflow-y-auto font-mono text-xs">
                    {mcpLastResponse ? (
                      <pre className="text-slate-200 whitespace-pre-wrap">
                        {JSON.stringify(mcpLastResponse, null, 2)}
                      </pre>
                    ) : (
                      <div className="text-slate-500 text-center py-12">
                        No MCP response yet. Select a tool and click "Invoke MCP Tool".
                      </div>
                    )}
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-800/80 text-[11px] text-slate-400 flex items-center justify-between font-mono">
                  <span>Authoritative Tick: {currentTick}</span>
                  <span className="text-cyan-400">Zero In-Memory Session Leak</span>
                </div>
              </div>
            </div>

            {/* MCP Audit Trail Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  MCP Security Audit Log (mcp_audit_logs)
                </h3>
                <span className="text-xs text-slate-400 font-mono">
                  {mcpAuditLogs.length} events logged
                </span>
              </div>

              <div className="overflow-x-auto border border-slate-800 rounded-lg bg-slate-950">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-slate-900 text-slate-400 uppercase text-[10px] border-b border-slate-800">
                    <tr>
                      <th className="p-2.5">Tick</th>
                      <th className="p-2.5">Grant ID</th>
                      <th className="p-2.5">Tool Name</th>
                      <th className="p-2.5">Payload Hash</th>
                      <th className="p-2.5">Result</th>
                      <th className="p-2.5">Latency</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {mcpAuditLogs.slice(-10).reverse().map((log) => (
                      <tr key={log.id} className="hover:bg-slate-900/60 transition">
                        <td className="p-2.5 font-bold text-amber-400">{log.tick}</td>
                        <td className="p-2.5 text-slate-300">{log.grantId}</td>
                        <td className="p-2.5 font-semibold text-cyan-400">{log.toolName}</td>
                        <td className="p-2.5 text-slate-400">0x{log.payloadHash}</td>
                        <td className="p-2.5">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              log.resultCode === 'SUCCESS'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : 'bg-rose-500/20 text-rose-400'
                            }`}
                          >
                            {log.resultCode}
                          </span>
                        </td>
                        <td className="p-2.5 text-slate-400">{log.executionTimeMs} ms</td>
                      </tr>
                    ))}
                    {mcpAuditLogs.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-slate-500">
                          No MCP audit records yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB: PRE-WEB3 ESCROW & LOTS */}
        {activeTab === 'web3' && (
          <div className="space-y-6">
            {/* Header info */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
                    <Lock className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                      Pre-Web3 Domain Model & Off-Chain Escrow
                    </h2>
                    <p className="text-xs text-slate-400">
                      Phase 1/2 off-chain ledger ready for Phase 3 EVM/Base settlement. Enforces Material
                      Conservation (Invariant 1) and Ownership/Usage separation (Invariant 2).
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-[10px] font-mono">
                  <span className="px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-purple-300">
                    ERC-1155 / EIP-712 Voucher Ready
                  </span>
                  <span className="px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-cyan-400">
                    Circuit Breaker Protected
                  </span>
                </div>
              </div>
            </div>

            {/* Circuit Breaker & Reconciliation Alert */}
            <div
              className={`p-4 rounded-xl border flex flex-wrap items-center justify-between gap-3 ${
                circuitBreakerStatus.isTripped
                  ? 'bg-rose-950/30 border-rose-800 text-rose-200'
                  : 'bg-emerald-950/20 border-emerald-800/60 text-emerald-300'
              }`}
            >
              <div className="flex items-center gap-3">
                {circuitBreakerStatus.isTripped ? (
                  <ShieldAlert className="w-6 h-6 text-rose-400 shrink-0" />
                ) : (
                  <ShieldCheck className="w-6 h-6 text-emerald-400 shrink-0" />
                )}
                <div>
                  <div className="text-xs font-bold font-mono uppercase tracking-wide">
                    {circuitBreakerStatus.isTripped
                      ? 'CIRCUIT BREAKER TRIPPED — LOT OPERATIONS HALTED'
                      : 'AUTOMATED CIRCUIT BREAKER: NORMAL & RECONCILED'}
                  </div>
                  <p className="text-[11px] opacity-80 mt-0.5">
                    {circuitBreakerStatus.isTripped
                      ? circuitBreakerStatus.reason
                      : 'Material conservation invariant verified: factory reserved inventories strictly equal active CommodityLots.'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleRunReconciliation}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-mono font-semibold transition"
                >
                  Run Reconcile Audit
                </button>
                {circuitBreakerStatus.isTripped && (
                  <button
                    onClick={handleResetCircuitBreaker}
                    className="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded text-xs font-mono font-semibold transition"
                  >
                    Reset Circuit Breaker
                  </button>
                )}
              </div>
            </div>

            {/* EIP-712 Voucher Inspector Modal/Card if Active */}
            {activeVoucher && (
              <div className="bg-slate-900 border border-purple-500/40 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold text-purple-400 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    EIP-712 Anti-Replay Voucher Emitted ({activeVoucher.lotId})
                  </span>
                  <button
                    onClick={() => setActiveVoucher(null)}
                    className="text-xs text-slate-400 hover:text-slate-200 font-mono"
                  >
                    Dismiss
                  </button>
                </div>
                <div className="bg-slate-950 p-3 rounded font-mono text-xs text-slate-300 overflow-x-auto border border-slate-800">
                  <pre>{JSON.stringify(activeVoucher, null, 2)}</pre>
                </div>
              </div>
            )}

            {/* Packaging and Escrow Forms */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Form 1: Package Lot */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
                <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                  <PlusCircle className="w-4 h-4 text-purple-400" />
                  Package Factory Inventory into CommodityLot
                </h3>
                <p className="text-xs text-slate-400">
                  Deducts physical stock from Available and locks into Reserved (Invariant 1).
                </p>

                <form onSubmit={handleCreateLot} className="space-y-3 text-xs">
                  <div>
                    <label className="text-slate-400 block mb-1">Company Origin</label>
                    <select
                      value={lotForm.companyId}
                      onChange={(e) => setLotForm({ ...lotForm, companyId: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                    >
                      {companies.map((c) => (
                        <option key={c.companyId} value={c.companyId}>
                          {c.name} ({c.companyId})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-slate-400 block mb-1">Item to Package</label>
                      <select
                        value={lotForm.itemId}
                        onChange={(e) =>
                          setLotForm({ ...lotForm, itemId: e.target.value as ItemId })
                        }
                        className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                      >
                        {(Object.keys(ITEM_IDS) as ItemId[]).map((it) => (
                          <option key={it} value={it}>
                            {it}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-slate-400 block mb-1">Lot Quantity</label>
                      <input
                        type="number"
                        min="1"
                        value={lotForm.quantity}
                        onChange={(e) =>
                          setLotForm({ ...lotForm, quantity: Number(e.target.value) })
                        }
                        className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-lg transition"
                  >
                    Lock & Create CommodityLot (RESERVED_OFF_CHAIN)
                  </button>
                </form>
              </div>

              {/* Form 2: Escrow Settings Template */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
                <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                  <Lock className="w-4 h-4 text-amber-400" />
                  TradeEscrow Default Parameters
                </h3>
                <p className="text-xs text-slate-400">
                  Default parameters applied when depositing a CommodityLot into TradeEscrow.
                </p>

                <div className="space-y-3 text-xs">
                  <div>
                    <label className="text-slate-400 block mb-1">Buyer Company</label>
                    <select
                      value={escrowParams.buyerId}
                      onChange={(e) =>
                        setEscrowParams({ ...escrowParams, buyerId: e.target.value })
                      }
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                    >
                      {companies.map((c) => (
                        <option key={c.companyId} value={c.companyId}>
                          {c.name} ({c.companyId})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-slate-400 block mb-1">Agreed Price (Cr)</label>
                      <input
                        type="number"
                        min="1"
                        value={escrowParams.agreedPrice}
                        onChange={(e) =>
                          setEscrowParams({ ...escrowParams, agreedPrice: Number(e.target.value) })
                        }
                        className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                      />
                    </div>

                    <div>
                      <label className="text-slate-400 block mb-1">Deadline Duration (Ticks)</label>
                      <input
                        type="number"
                        min="50"
                        step="50"
                        value={escrowParams.deadlineOffsetTicks}
                        onChange={(e) =>
                          setEscrowParams({
                            ...escrowParams,
                            deadlineOffsetTicks: Number(e.target.value),
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono"
                      />
                    </div>
                  </div>

                  <div className="p-3 bg-slate-950 rounded border border-slate-800 text-[11px] font-mono space-y-1">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Seller Collateral (20%):</span>
                      <span className="text-rose-400 font-semibold">
                        {Math.floor((escrowParams.agreedPrice * 20) / 100)} Cr
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Market Burn Fee (2%):</span>
                      <span className="text-amber-400 font-semibold">
                        {Math.floor((escrowParams.agreedPrice * 2) / 100)} Cr
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* CommodityLots Active Ledger */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <Coins className="w-4 h-4 text-purple-400" />
                  Commercial Commodity Lots ({lots.length})
                </h3>
                <span className="text-xs text-slate-400 font-mono">
                  State Machine: RESERVED ➔ TOKENIZED ➔ IN_ESCROW ➔ SETTLED ➔ CONSUMED
                </span>
              </div>

              {lots.length === 0 ? (
                <div className="p-6 text-center text-slate-500 bg-slate-950 rounded-lg text-xs font-mono border border-slate-800">
                  No Commodity Lots packaged yet. Use the form above to lock inventory materials.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {lots.map((lot) => (
                    <div
                      key={lot.lotId}
                      className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs space-y-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold text-slate-200">{lot.lotId}</span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                            lot.status === 'RESERVED_OFF_CHAIN'
                              ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                              : lot.status === 'TOKENIZED_RECEIPT'
                              ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                              : lot.status === 'IN_ESCROW'
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                              : lot.status === 'SETTLED_PENDING_CLAIM'
                              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                              : lot.status === 'CONSUMED_UNPACKED'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {lot.status}
                        </span>
                      </div>

                      <div className="font-mono text-slate-300 text-[11px] space-y-1">
                        <div>
                          <span className="text-slate-500">Item:</span>{' '}
                          <span className="text-slate-100 font-bold">
                            {lot.quantity} {lot.itemId}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500">Origin:</span> {lot.originCompanyId}
                        </div>
                        <div>
                          <span className="text-slate-500">Integrity Hash:</span>{' '}
                          <code className="text-purple-400">0x{lot.stateHash}</code>
                        </div>
                      </div>

                      {/* State Machine Transition Actions */}
                      <div className="pt-2 border-t border-slate-800/80 flex flex-wrap gap-1.5">
                        {lot.status === 'RESERVED_OFF_CHAIN' && (
                          <>
                            <button
                              onClick={() => handleTokenizeLot(lot.lotId)}
                              className="px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded text-[10px] font-mono font-bold transition"
                            >
                              Sign EIP-712 Voucher
                            </button>
                            <button
                              onClick={() => handleOpenEscrow(lot)}
                              className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded text-[10px] font-mono font-bold transition"
                            >
                              Open Escrow
                            </button>
                            <button
                              onClick={() => handleRevertLot(lot.lotId)}
                              className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] font-mono transition"
                            >
                              Revert
                            </button>
                          </>
                        )}

                        {lot.status === 'TOKENIZED_RECEIPT' && (
                          <button
                            onClick={() => handleOpenEscrow(lot)}
                            className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded text-[10px] font-mono font-bold transition"
                          >
                            Deposit in Escrow
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Trade Escrow Records Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Active & Released Trade Escrows ({escrows.length})
              </h3>

              {escrows.length === 0 ? (
                <div className="p-4 text-center text-slate-500 bg-slate-950 rounded-lg text-xs font-mono border border-slate-800">
                  No trade escrows initiated yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {escrows.map((esc) => (
                    <div
                      key={esc.escrowId}
                      className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs flex flex-wrap items-center justify-between gap-4 font-mono"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-amber-400">{esc.escrowId}</span>
                          <span className="text-slate-400">({esc.lotId})</span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              esc.settlementState === 'LOCKED'
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            }`}
                          >
                            {esc.settlementState}
                          </span>
                        </div>
                        <div className="text-slate-400 text-[11px] mt-1">
                          Seller: {esc.sellerCompanyId} ➔ Buyer: {esc.buyerCompanyId} • Price:{' '}
                          {esc.agreedPriceAmount} Cr • Collateral: {esc.sellerCollateralAmount} Cr
                        </div>
                      </div>

                      {esc.settlementState === 'LOCKED' && (
                        <button
                          onClick={() => handleSettleDelivery(esc.escrowId)}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded text-xs transition"
                        >
                          Execute Settlement & Deliver (2% Fee Burn)
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: ENGINE DIAGNOSTICS & REPLAY */}
        {activeTab === 'diagnostics' && (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <Cpu className="w-5 h-5 text-amber-400" />
                Deterministic Engine State & Audit Log
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Zero float math. Verified Mulberry32 PRNG seed state. Deterministic state hash for
                lossless replay validation.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-800">
                  <div className="text-[10px] font-mono uppercase text-slate-500">
                    State Hash (FNV-1a)
                  </div>
                  <div className="font-mono font-bold text-amber-400 text-sm mt-1">
                    0x{stateHash}
                  </div>
                </div>

                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-800">
                  <div className="text-[10px] font-mono uppercase text-slate-500">
                    Pending Queued Commands
                  </div>
                  <div className="font-mono font-bold text-emerald-400 text-sm mt-1">
                    {engine.getCommandQueue().getPendingCount()}
                  </div>
                </div>

                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-800">
                  <div className="text-[10px] font-mono uppercase text-slate-500">
                    Commands Executed
                  </div>
                  <div className="font-mono font-bold text-cyan-400 text-sm mt-1">
                    {engine.getExecutionHistory().length}
                  </div>
                </div>
              </div>
            </div>

            {/* Execution Audit Log */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-slate-200 mb-3">
                Authoritative Command Execution Log (Recent)
              </h3>
              <div className="max-h-72 overflow-y-auto space-y-2 text-xs font-mono">
                {engine.getExecutionHistory(15).reverse().map((res, idx) => (
                  <div
                    key={idx}
                    className={`p-2.5 rounded border flex items-center justify-between ${
                      res.success
                        ? 'bg-slate-950/60 border-slate-800 text-slate-300'
                        : 'bg-rose-950/20 border-rose-900/40 text-rose-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-slate-500 text-[10px]">Tick {res.executedAtTick}</span>
                      <span className="font-semibold">{res.commandId}</span>
                    </div>
                    <div>
                      {res.success ? (
                        <span className="text-emerald-400 font-bold">SUCCESS</span>
                      ) : (
                        <span className="text-rose-400 font-bold">
                          {res.errorCode}: {res.errorMessage}
                        </span>
                      )}
                    </div>
                  </div>
                ))}

                {engine.getExecutionHistory().length === 0 && (
                  <div className="text-slate-500 py-4 text-center">
                    No commands processed yet in this session.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
