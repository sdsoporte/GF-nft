GAME_DESIGN_MVP.md — Especificación de Diseño y Balance Matemático (Fase 1)
Proyecto: GigaForge v4.1
Entregable: A (Backlog P0)
Corte de diseño: 26 de octubre de 2026
Alcance: Vertical Slice Digital (30–45 minutos, 3–4 jugadores o 2 jugadores + 1 proveedor simulado).


________________


1. Parámetros Fundamentales de la Partida
* Duración estándar: 45 minutos = 2.700 ticks (1 tick = 1 segundo real).
* Aritmética del motor: 100% entera (integer). No existen fracciones de materiales ni de créditos.
* Configuración de sesión (Mínima para formación de precios):
   * 4 Empresas en total: 2 de Clase A (Metalurgia) y 2 de Clase B (Manufactura y Logística). Si solo hay 2 jugadores humanos (1 A y 1 B), el servidor instancia 2 proveedores NPC competitivos con reglas deterministas de precios para obligar a comparar ofertas.
* Capital y Capacidad Inicial por Empresa (Tick 0):
   * Créditos Industriales (CREDITS): 10.000
   * Mineral Bruto (RAW_ORE): 200 unidades
   * Generación base de Energía (ENERGY): +20 unidades/tick (Almacenamiento máx. inicial: 1.000)
   * Líneas de producción activas iniciales: 3 líneas configurables.


________________


2. Especializaciones (Clases Industriales)
Ninguna clase tiene prohibido fabricar una receta básica o intermedia, pero producir fuera de su especialización aplica una penalización de tiempo (+100%) y de costo energético (+80% a +100%), haciendo que el comercio mediante contratos B2B sea aproximadamente un 40%–48% más eficiente que la autarquía.


1. Clase A — Metalurgia Pesada:
   * Ventaja: Hornos de arco e inducción optimizados. Recetas metalúrgicas (1, 2 y 3) operan a velocidad y costo base óptimos.
   * Dependencia: Ensamblar circuitos o módulos (Recetas 4, 5 y 6) le resulta lento y drena su red eléctrica.
2. Clase B — Manufactura y Logística:
   * Ventaja: Líneas de ensamblaje automatizadas y logística de bajo costo. Recetas mecánicas/electrónicas (4, 5 y 6) operan a costo óptimo y el transporte de contratos le cuesta 0 de energía adicional (Clase A paga 2 de energía por lote enviado).
   * Dependencia: Fundir acero y aleaciones (Recetas 1, 2 y 3) consume el doble de tiempo y energía.


________________


3. Catálogo de las 8 Recetas y Balance Matemático (Enteros)
Extracción Base (Común a ambas clases)
* Extracción de Mineral Bruto (RAW_ORE): 1 línea extractora produce 5 RAW_ORE cada 10 ticks consumiendo 15 ENERGY.
Tabla de Recetas (1 a 8)
ID
	Receta / Producto
	Insumos Requeridos (por lote)
	Output
	Tiempo Clase A (Ticks)
	Energía Clase A
	Tiempo Clase B (Ticks)
	Energía Clase B
	Costo Base Estimado (Créditos)
	R1
	IRON_INGOT (Lingote de Hierro)
	10 RAW_ORE
	5
	10 (Óptimo)
	20
	20 (Penalizado)
	40
	50
	R2
	STEEL_PLATE (Placa de Acero)
	4 IRON_INGOT + 5 RAW_ORE
	4
	15 (Óptimo)
	35
	30 (Penalizado)
	70
	120
	R3
	HEAVY_ALLOY (Aleación Pesada)
	4 STEEL_PLATE + 10 RAW_ORE
	2
	25 (Óptimo)
	60
	55 (Penalizado)
	120
	320
	R4
	MECH_FRAME (Bastidor Mecánico)
	4 STEEL_PLATE + 2 IRON_INGOT
	2
	30 (Penalizado)
	60
	15 (Óptimo)
	30
	220
	R5
	CTRL_CIRCUIT (Circuito de Control)
	2 IRON_INGOT + 6 RAW_ORE
	2
	40 (Penalizado)
	80
	20 (Óptimo)
	35
	160
	R6
	POWER_MODULE (Módulo de Energía)
	2 MECH_FRAME + 2 CTRL_CIRCUIT + 2 HEAVY_ALLOY
	1
	50 (Penalizado)
	110
	25 (Óptimo)
	50
	650
	R7
	IND_TURBINE (Turbina Industrial - Sink)
	2 POWER_MODULE + 4 HEAVY_ALLOY
	1
	40 (Igual)
	90
	40 (Igual)
	90
	2.200
	R8
	MEGAMACHINE_PART (Sección Megamáquina - Meta)
	2 IND_TURBINE + 4 MECH_FRAME + 4 STEEL_PLATE
	1
	60 (Igual)
	150
	60 (Igual)
	150
	5.500
	

________________


4. Sumideros Económicos (Sinks) y Utilidad de R7 y R8
1. Mantenimiento y Desgaste (Sink continuo):
   * Cada 300 ticks (5 minutos), cada línea activa consume 100 CREDITS de mantenimiento operativo y requiere energía constante.
   * A partir del minuto 15 (Tick 900), ampliar la capacidad eléctrica (+15 ENERGY/tick y +1 línea de producción) exige consumir e instalar 1 IND_TURBINE (R7) del propio inventario (se destruye el ítem y se mejora la fábrica).
2. Demanda del Sistema (Pedidos Corporativos Externos):
   * El servidor publica pedidos con cupo limitado para inyectar CREDITS frescos a cambio de destruir IND_TURBINE (R7) y POWER_MODULE (R6).
3. Proyecto Cooperativo Global (MEGAMACHINE_PART - R8):
   * Para superar el escenario en 45 minutos, entre todas las empresas de la partida deben entregar un total de 12 MEGAMACHINE_PART (R8) al Ensamblador Central antes del Tick 2.700.


________________


5. Plantilla de Contrato de Suministro B2B (Off-Chain MVP)
En el MVP, los contratos se liquidan en el ledger autoritativo del servidor (SQLite) con bloqueo en garantía (escrow interno) para evitar estafas sin usar aún blockchain.
Estructura de Datos del Contrato (SupplyContract)
{


  "contract_id": "cnt_20261026_0042",


  "seller_company_id": "comp_metal_01",


  "buyer_company_id": "comp_manuf_02",


  "item_id": "STEEL_PLATE",


  "total_quantity": 20,


  "delivered_quantity": 0,


  "unit_price_credits": 38,


  "total_value_credits": 760,


  "collateral_seller_credits": 152,


  "created_at_tick": 420,


  "deadline_tick": 900,


  "penalty_per_missing_unit": 10,


  "status": "ACTIVE"


}
Reglas de Liquidación Interna:
1. Al firmar (PENDING $\rightarrow$ ACTIVE): El servidor bloquea 760 CREDITS de la cuenta del Comprador y 152 CREDITS (20% de colateral de cumplimiento) de la cuenta del Vendedor.
2. Al entregar (ACTIVE $\rightarrow$ FULFILLED): Cuando el Vendedor despacha las 20 STEEL_PLATE antes del Tick 900, el servidor transfiere el material al Comprador, libera el colateral de 152 CREDITS al Vendedor y le acredita los 760 CREDITS del pago (menos 2% de tasa de mercado = 15 CREDITS quemados como sumidero monetario).
3. Por incumplimiento (Tick > 900 y delivered < total): El contrato pasa a DEFAULTED. El Comprador recupera el pago por las unidades no entregadas más la indemnización tomada del colateral del Vendedor (penalty_per_missing_unit), y el Vendedor pierde +15 puntos de Reputación Industrial.


________________


6. Condiciones de Victoria (Equilibrio Cooperativo-Competitivo)
1. Condición Global (Supervivencia del Sector): Si en el Tick 2.700 el Ensamblador Central no tiene las 12 MEGAMACHINE_PART, el proyecto industrial fracasa y ninguna empresa obtiene el bono de victoria.
2. Ranking Individual de Empresas (Ganador de la Partida): Si se cumple la meta global, las empresas se clasifican según su Valor Neto Industrial (NetWorth) en el Tick 2.700: $$\text{NetWorth} = \text{CREDITS Disponibles} + (\text{Partes R8 Aportadas} \times 6.000) + (\text{Turbinas R7 Instaladas} \times 2.000) + (\text{Reputación de Contratos} \times 50)$$ Esto asegura que regalar recursos sin cobrar te haga perder contra tu competidor, pero negarte a comerciar hunda la meta global.