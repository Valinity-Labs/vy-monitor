# Valinity Monitor

Dashboard de monitoreo en tiempo real para el protocolo Valinity, permitiendo visualizar métricas críticas de activos, préstamos y colaterales en blockchains EVM.

## 🏗️ Stack Tecnológico

| Aspecto | Detalles |
|---------|----------|
| **Framework** | React 19.1.1 |
| **Lenguaje** | TypeScript 5.9.3 |
| **Bundler** | Vite (Rolldown) |
| **Interacción Blockchain** | Viem 2.x |
| **Utilidades** | Lodash 4.17.21 |

## 📁 Estructura del Proyecto

```
src/
├── components/          # Componentes React reutilizables
│   └── core.tsx         # Componente genérico <Value>
├── pages/               # Páginas principales
│   ├── Mainnet.tsx      # Dashboard para Mainnet
│   └── Testnet.tsx      # Dashboard de Sepolia (ya no se muestra; el monitor es sólo mainnet)
├── models/              # Clases de modelos de datos
│   ├── Amount.ts        # Representa cantidades monetarias
│   ├── Currency.ts      # Información de monedas/tokens
│   └── index.ts
├── networks/            # Configuración de redes blockchain
│   ├── mainnet/         # Direcciones y ABIs de Mainnet
│   ├── sepolia/         # Direcciones y ABIs de Sepolia
│   ├── common/          # ABIs compartidos (ERC20, Portales, Registradores)
│   └── index.ts
├── resources/           # Funciones de recursos
│   └── getContractAddresses.ts  # Obtiene direcciones dinámicas
├── utils/               # Funciones auxiliares
│   ├── createResource.ts        # Sistema de caché de datos
│   └── formatValue.ts           # Formatea valores para UI
├── App.tsx              # Componente raíz
└── config.ts            # Configuración (RPC URLs, etc)
```

## 🔑 Características Principales

- **Sólo Ethereum mainnet**: el encabezado dice "Ethereum mainnet" (sin enlace); Sepolia ya no se usa
- **Monitoreo de Activos**: Precios spot, LTV, reservas y préstamos con valores en USD
- **Llamadas RPC Optimizadas**: Usa `multicall` para obtener múltiples datos en una sola llamada

### Contratos Inteligentes Monitoreados

- `ValinityAssetRegistry` - Registro de activos
- `ValinityAcquisitionOfficer` - Gestión de adquisiciones
- `ValinityCapOfficer` - Control de límites
- `ValinityLoanOfficer` - Gestión de préstamos
- `ValinityToken` (VY) - Token nativo
- `ValinityRegistrar` - Registro dinámico de contratos

## 📦 Scripts Disponibles

```bash
npm run dev      # Inicia servidor de desarrollo
npm run build    # Compila TypeScript + Vite build
npm run lint     # Ejecuta ESLint
npm run preview  # Previsualiza build producción
```

## 🚀 Despliegue con GitHub Pages

El sitio se publica **automáticamente** con GitHub Actions en cada push a la rama `gh-pages`
(`.github/workflows/deploy-pages.yml`), o a mano desde **Actions → Deploy to GitHub Pages →
Run workflow**. Ya no se hace build y commit de `docs/` a mano: `docs/` está en `.gitignore`.

### URLs por Ambiente

| Ambiente | URL |
|----------|-----|
| **Mainnet** | `https://valinity-labs.github.io/vy-monitor/` |

### Qué hace el workflow

1. Descarga el código de `gh-pages`.
2. Descarga la librería de TradingView desde app.valinity.io y **verifica cada archivo** contra
   `scripts/charting_library.sha256` — nunca se versiona en este repo público.
3. `npm ci` y `npm run build`, que genera `docs/`.
4. Publica `docs/` en GitHub Pages.

Para probar el build en local: `npm run build && npm run preview`.

### Configuración (una sola vez)

- **Settings → Pages → Source:** GitHub Actions.
- **Settings → Environments → `github-pages`:** puede desplegar desde `gh-pages`.
- No hace falta ningún secreto ni credencial.

### Configuración de Vite

```typescript
// vite.config.ts
export default defineConfig({
  base: '/vy-monitor/',    // URL base del repositorio
  build: {
    outDir: 'docs'         // Output a carpeta docs/
  }
})
```

## 📈 Precio histórico (gráfico + tape)

La primera sección del monitor es el precio de Valinity en velas (TradingView Advanced Charts)
con un tape estilo DexScreener debajo: cada operación con su precio, la dirección que la hizo,
la cantidad, el valor en USD y el enlace al explorador (las 100 más recientes).

Abre mostrando **sólo el pool actual** (VY/USDC en Uniswap V2) en los **últimos 3 meses**, con
velas diarias y las líneas de BTC/ETH/oro encendidas. El botón **"Since Genesis"** cambia
gráfico, estadísticas y tape a la vez para mostrar todos los contratos desde 2021 (abre en
**All**, velas semanales); **"← Live Pool"** vuelve al pool actual. Los botones **30D · 3M · 6M · 12M
· All** eligen la ventana de tiempo en ambas vistas; en la del pool actual las líneas de
BTC/ETH/oro arrancan en el precio de VY al inicio de la ventana elegida.

En la vista del pool actual el gráfico dibuja además **BTC (naranja), ETH (gris) y oro
(amarillo)** — los tres activos de la reserva — como si el primer precio del pool ($0,0691, el
13-abr-2026) se hubiera invertido en cada uno en vez de en VY. Cada línea empieza exactamente en
ese precio y luego se mueve con el rendimiento en USD de su activo, así que se compara directo
con las velas; encima del gráfico se muestra el rendimiento de cada uno desde ese día. Los
precios son los feeds on-chain de Chainlink (BTC/USD, ETH/USD, XAU/USD), y cada línea se lee en
el instante de cierre de su vela (`barCloseTime`), no en su apertura. Las tres líneas empiezan
**encendidas**: se apagan y encienden con los botones BTC / ETH / Gold sobre el gráfico o con el
👁 junto a cada nombre en la leyenda del gráfico, y ambos controles quedan sincronizados.

Valinity ha operado bajo varios contratos en dos cadenas. Cada uno es una "era", y todas se
aplanan en una sola lista `Trade[]` (`src/utils/priceHistory.ts`), de modo que el gráfico y el
tape nunca necesitan saber de qué era viene cada operación:

| Era | Cadena | Mercado | Periodo | Operaciones |
|-----|--------|---------|---------|-------------|
| MFC v1 | BNB Chain | Libro P2P (BUSD) | dic 2021 – may 2022 | 175 |
| MFC v2 | BNB Chain | Libro P2P | may 2022 | **excluida** (1 prueba de $10) |
| MFC v3 | BNB Chain | Libro P2P (BUSD) | may – jun 2022 | 68 |
| MFC v4 | BNB Chain | Libro P2P (BUSD) | oct 2022 – abr 2023 | 157 |
| VY (legacy) | Ethereum | Uniswap V2 VY/WETH | abr 2024 – dic 2025 | 3.526 |
| VY (live) | Ethereum | Uniswap V2 VY/USDC | abr 2026 – **hoy** | 1.053 |

**Qué precio se grafica:** el pool actual (VY/USDC) se grafica al **precio del propio pool**
después de cada operación — reserva de USDC ÷ reserva de VY, del evento `Sync` — que es el
precio que cotiza el pool, el que lee la web app con `getReserves()` y el que muestra
DexScreener. El tape muestra lo que pagó cada operación. Las eras MFC (sin reservas) y el pool
legacy se grafican al precio ejecutado. **No hay reconversión:** las eras se empalman en crudo.

### Regenerar los datos

Ambas eras están cerradas, así que se escanean una vez y el resultado se versiona — la app
publicada no hace ninguna llamada RPC para el gráfico:

```bash
node scripts/build-mfc-history.mjs   # -> src/data/mfcHistory.json  (BNB Chain, 4 eras)
node scripts/build-eth-history.mjs   # -> src/data/vyHistory.json    (Ethereum, 2 pools)
node scripts/build-benchmarks.mjs    # -> src/data/benchmarks.json   (Chainlink BTC/ETH/XAU)
```

La era actual **sigue viva**, así que `vyHistory.json` es una foto del bloque en que se generó
(`builtAtBlock`). `src/utils/liveTail.ts` se pone al día al cargar — un `getLogs` de Swap + Sync
y peticiones JSON-RPC agrupadas — y luego consulta cada 30 segundos sólo los bloques nuevos. La
página abre tras una pantalla de carga ("Loading data directly from the Ethereum blockchain", con
segundos; el Ethereum metálico de la web flotando en el centro y la V 3D de valinity.io — portada de
`valinity-landing`, Three.js cargado en segundo plano — pequeña, girando y orbitándolo) y aparece **entera de una vez** cuando el gráfico ya está dibujado con esa puesta al día
y el balance respondió — o a los 20 s como máximo (`src/utils/loadLimit.ts`), mostrando lo que
haya. Así lo primero que se ve es el presente; las velas nuevas se **añaden al gráfico abierto** (nunca se reconstruye). Si algo
falla, se conserva lo que hay y se reintenta en la siguiente consulta.
Lo mismo con `benchmarks.json`: al cargar, el tail lee los tres feeds desde su `builtAtBlock`
hasta la cabeza (una muestra por día, 60 llamadas como máximo).

Ambos aceptan `--rpc <url>`. El de MFC necesita un nodo **archive** de BSC que acepte ventanas
`getLogs` amplias (los dataseeds públicos de Binance están podados); es reanudable mediante un
caché de rangos en `.cache/mfc/<era>/` y se niega a escribir un historial con huecos. El de
Ethereum lee todo el pool en una sola llamada a través de `api.valinity.io/rpc-proxy`.

### Decisiones que hay que conocer para leer el gráfico

- **MFC nunca tuvo pool de liquidez.** Verificado contra PancakeSwap V1/V2, Biswap y ApeSwap
  para pares BUSD, USDT, WBNB y USDC: nunca se creó ninguno. Los cuatro contratos operaron en
  libros de ofertas on-chain, así que esos años se ven como escalones, no como velas orgánicas,
  y **toda operación MFC es una compra** (el libro sólo emite `TradeOffer` al llenar una oferta
  existente). La era de Ethereum sí tiene ambos lados.
- **Dos huecos reales:** jun–oct 2022 y abr 2023–abr 2024, sin ningún mercado activo. Las velas
  arrastran el último precio operado, que es la única lectura honesta.
- **El día de lanzamiento en Ethereum (3-abr-2024) no se grafica:** 281 swaps de descubrimiento
  de precio en un pool sembrado con ~8 WETH, de $0,22 a $7,94 y de vuelta a $0,35 en el mismo
  día. Son reales y siguen en `vyHistory.json`, pero se excluyen (`LAUNCH_EXCLUSION`) porque una
  excursión de un día seis veces por encima de todo lo demás fijaría la escala de cuatro años.
  El gráfico abre en la banda donde vivió el activo (`openingPriceBand`) y en **escala
  logarítmica**, porque la vida completa abarca de $0,0179 a $1,33.
- **El pool legacy se cerró el 20-dic-2025**, cuando dos `Burn` lo vaciaron (−406.803 VY /
  −47,3 WETH). Después sólo queda polvo y el "precio" es una división por un error de redondeo.
  El pool actual (VY/USDC) abrió el 13-abr-2026 en **$0,0691** — la caída desde los $0,3494 del
  cierre anterior — y desde ahí se recuperó.
- **Se descarta una transacción del pool actual:** un flash loan del 14-jul-2026
  (`0x2176cea6…`) con once swaps que movieron 453.676 VY, catorce veces las reservas del pool,
  imprimiendo entre $0,04 y $228 mientras VY valía ~$0,15. Se elimina la transacción **completa**,
  no sólo los precios extremos: una transacción atómica es un único evento económico y sus
  tramos "normales" son la misma manipulación vista desde el otro lado.
- **USD en la era Ethereum** sale del feed Chainlink ETH/USD muestreado a diario e interpolado
  al bloque de cada swap — no del precio de ETH de hoy.

### TradingView Advanced Charts

La librería está sujeta a licencia y **no es redistribuible**, y **este repositorio es
público**, así que **nunca se versiona aquí** (`public/charting_library/` está en `.gitignore`).
En cada build se descarga desde app.valinity.io (la web app ya sirve exactamente los mismos
archivos) y **cada archivo se verifica** contra su SHA-256 en `scripts/charting_library.sha256`:
si falta o cambia uno solo, el build falla y no se publica nada. Así sólo llega al sitio
publicado, igual que en la web app, sin credenciales de por medio.

Para desarrollo local: `node scripts/fetch-charting-library.mjs`. Si la web app actualiza
TradingView, regenera la lista con
`node scripts/fetch-charting-library.mjs --write-manifest <ruta-a-charting_library>`.

## 📄 Licencia

MIT
