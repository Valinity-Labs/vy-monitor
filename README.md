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
│   └── Testnet.tsx      # Dashboard para Sepolia Testnet
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

- **Dual Network Support**: Soporta Mainnet y Sepolia Testnet con interfaz unificada
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

Este proyecto está configurado para desplegarse en GitHub Pages.

### URLs por Ambiente

| Ambiente | URL |
|----------|-----|
| **Mainnet** (default) | `https://iterateco.github.io/vy-monitor/` |
| **Mainnet** | `https://iterateco.github.io/vy-monitor/?network=mainnet` |
| **Testnet** | `https://iterateco.github.io/vy-monitor/?network=sepolia` |

### Pasos para Desplegar

#### 1. Compilar el proyecto

```bash
npm run build
```

Esto genera los archivos estáticos en la carpeta `docs/`.

#### 2. Subir a GitHub

```bash
git add docs/
git commit -m "Build for GitHub Pages"
git push origin main
```

#### 3. Configurar GitHub Pages (una sola vez)

1. Ve a tu repositorio en GitHub
2. **Settings** → **Pages**
3. En "Source", selecciona:
   - **Branch**: `main`
   - **Folder**: `/docs`
4. Click en **Save**

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

## 📄 Licencia

MIT
