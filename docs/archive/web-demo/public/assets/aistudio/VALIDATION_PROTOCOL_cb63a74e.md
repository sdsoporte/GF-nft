VALIDATION_PROTOCOL.md — Protocolo de Pruebas A/B/C, Telemetría y Puertas de Decisión
Proyecto: GigaForge v4.1
Entregable: D (Backlog P0)
Corte de diseño: 26 de octubre de 2026
Propósito: Establecer la metodología experimental, las métricas de instrumentación y los umbrales de éxito/pivote para validar el Vertical Slice (Fases 1 y 1B) y la Puerta de Demanda previa a Web3 (Fase 2 $\rightarrow$ Fase 3).


________________


1. Diseño Experimental (Fase 1 y Fase 1B)
1.1 Muestra y Configuración de Sesión
* Participantes: 12 a 16 jugadores reclutados en 3 perfiles:
   1. Aficionados a factory builders y juegos de gestión (ej. Factorio, Satisfactory, Anno).
   2. Desarrolladores / usuarios técnicos familiarizados con scripts, APIs o agentes MCP.
   3. Jugadores con experiencia en economías MMO o juegos Web3 (EVE Online, Town Star, Sunflower Land).
* Formato de Partida: Grupos de 4 empresas por sesión (2 de Clase A Metalurgia y 2 de Clase B Manufactura). Si en un turno asisten 2 o 3 jugadores humanos, los cupos restantes hasta 4 se completan con bots proveedores deterministas del servidor para garantizar siempre al menos 2 alternativas de proveedor por insumo clave.
* Duración de cada partida: 45 minutos (2.700 ticks), precedidos por un tutorial guiado de 10 minutos.
1.2 Las Tres Variantes de Control (Diseño Intra-Sujeto Cruzado)
Cada grupo juega sesiones bajo las tres modalidades de control (cambiando el orden mediante un diseño cuadrado latino para evitar sesgo de aprendizaje):


Variante
	Modo de Operación Permitido
	Qué Hipótesis Pone a Prueba
	Variante A
	100% Manual (UI Web 2D)
	¿El bucle de construir, especializarse y negociar contratos B2B es divertido y comprensible por sí mismo?
	Variante B
	Manual + Scripts/Reglas deterministas (sin LLM)
	¿Automatizar umbrales repetitivos (ej. reiniciar líneas o despachar lotes) reduce la fatiga sin matar las decisiones comerciales?
	Variante C
	Manual + Agente Externo vía MCP (con presupuesto de llamadas acotado)
	¿La interfaz MCP es cómoda de autorizar, segura y aporta valor de interoperabilidad sin convertirse en pay-to-win?
	

Control de costos en Variante C: Se fija un tope estricto de 50 llamadas al modelo LLM por participante por partida de 45 min y un límite en el Gateway MCP de 12 comandos de escritura por minuto, registrando el modelo exacto utilizado (ej. Gemini 2.5 Flash/Pro, Claude Sonnet, o modelo local).


________________


2. Instrumentación y Telemetría Obligatoria (Logs del Servidor)
El servidor SQLite debe registrar automáticamente los siguientes eventos por partida (match_telemetry):


1. Métricas de Comercio y Formación de Precios:
   * voluntary_contracts_signed: Número de contratos firmados fuera del paso obligatorio del tutorial.
   * quote_comparisons_count: Cuántas veces un comprador consultó precios de ambos proveedores antes de firmar.
   * make_vs_buy_ratio: Porcentaje de insumos intermedios (STEEL_PLATE, CTRL_CIRCUIT) adquiridos por contrato frente a fabricados con penalización fuera de clase.
   * contract_default_rate: Porcentaje de contratos incumplidos y colateral ejecutado.
2. Métricas de Carga Operativa y MCP:
   * manual_clicks_per_minute: Acciones manuales en la UI divididas en rutinarias (recargar línea) vs. estratégicas (negociar contrato, expandir turbina).
   * mcp_commands_accepted vs. mcp_commands_rejected: Desglosado por código de error (ERR_RATE_LIMIT, ERR_SCOPE, ERR_INSUFFICIENT_ENERGY).
   * mcp_setup_time_seconds: Tiempo que tarda el jugador en vincular su cliente MCP y configurar permisos.
   * NetWorth_final: Puntaje económico final por variante (A vs. B vs. C) para verificar que la Variante C no aplaste injustamente a la Variante B.


________________


3. Cuestionario Post-Partida (Escala Likert 1 a 5 + Preguntas Abiertas)
Al terminar cada sesión de 45 minutos, cada participante responde en menos de 3 minutos:


1. Retención inmediata: "Si pudieras jugar otra partida de 45 minutos esta semana para probar una nueva estrategia comercial, ¿lo harías?" (Sí / No / Por qué).
2. Fricción vs. Estrategia (1–5): "Sentí que mi tiempo se fue en decisiones interesantes (precios, contratos, cuellos de botella) en lugar de hacer clics mecánicos repetitivos."
3. Interdependencia B2B (1–5): "Dependía realmente de negociar con otras empresas para ser competitivo, y tuve opciones reales para elegir proveedor."
4. Experiencia MCP (Solo en Variantes B y C, 1–5): "Configurar los permisos y dejar que la automatización operara mis líneas fue más cómodo que hacerlo a mano, sin sentir que perdía el control de mi empresa."
5. Pregunta abierta de dolor: "¿En qué momento exacto de la partida sentiste frustración, confusión o aburrimiento?"


________________


4. Criterios de Éxito y Reglas Previas para Pivotar
Estos umbrales se fijan antes de correr las pruebas para evitar autoengaño:


Criterio
	Umbral de Aprobación (Pasa a Fase 2)
	Señal de Alarma / Acción de Pivote
	1. Diversión y Retención Base
	$\ge 70%$ de los participantes pide jugar otra sesión o continuar mejorando su empresa.
	Si es $< 50%$: Detener todo desarrollo técnico de Fase 2/Web3. Revisar ritmo de ticks, claridad de UI y balance de las 8 recetas.
	2. Comercio B2B Genuino
	$\ge 60%$ firma al menos 1 contrato voluntario adicional post-tutorial, comparando entre $\ge 2$ opciones.
	Si los jugadores prefieren la autarquía: Aumentar la penalización energética fuera de clase o reducir el costo/fricción de crear ofertas.
	3. Utilidad de MCP sin Pay-to-Win
	Reducción de $\ge 40%$ en clics rutinarios en Variantes B/C, y diferencia de NetWorth entre Variante B (Scripts) y C (LLM) $< 20%$.
	Si configurar permisos toma $> 5$ min o molesta: Simplificar UI de presets de permisos MCP. Si el LLM domina por fuerza bruta: Ajustar rate limits y cooldowns.
	4. Seguridad e Integridad
	0 incidentes de acceso cruzado entre empresas, 0 órdenes duplicadas y reproducción 100% exacta del estado final en el test de replay.
	Cualquier fallo aquí bloquea el paso a Fase 2 hasta corregir la cola autoritativa y el motor determinista.
	

________________


5. Protocolo de la "Puerta de Demanda" (Fase 2 $\rightarrow$ Fase 3 Web3)
De acuerdo con la sección 11 de GigaForge v4.1, no se activará la Fase 3 (Web3 Testnet / Wallets / Smart Contracts) por simple inercia del calendario. Durante la Fase 2 (Mundo Económico Persistente con licencias off-chain), se deberán cumplir simultáneamente estas 3 condiciones empíricas:


1. Demanda Orgánica de Licencias y Alquileres (Modelos A y B off-chain): Al menos el 30% de las empresas activas en el mundo persistente utiliza el mercado interno para alquilar blueprints temporales o comerciar lotes grandes durante 2 semanas consecutivas.
2. Necesidad de Custodia / Liquidación Externa: Los jugadores recurrentes manifiestan interés explícito en conservar la propiedad de sus blueprints o liquidar acuerdos de alto volumen fuera de la sesión, existiendo un caso de uso claro que el ledger interno no satisfaga por sí solo.
3. Resiliencia Anti-Bots Demostrada: La economía de Fase 2 mantiene estabilidad de precios en las 8 recetas sin que cuentas automatizadas por MCP logren drenar los sumideros ni monopolizar los insumos básicos.


Regla por defecto: Si la Fase 1 y la Fase 2 son un éxito de entretenimiento pero la Puerta de Demanda Web3 no se cumple aún, GigaForge continúa escalando como juego de estrategia industrial con propiedad y contratos off-chain, postergando la capa blockchain hasta que el volumen económico de los jugadores lo justifique.