import abis from './abis';

export default {
  abis: abis,
  registeredContractNames: [
    'ValinityAssetRegistry',
    'ValinityToken',
    'ValinityAcquisitionTreasury',
    'ValinityReserveTreasury',
    'ValinityAcquisitionOfficer',
    'ValinityCapOfficer',
    'ValinityLoanOfficer',
    'ValinityPortal'
  ],
  addresses: {
    Company: '0x09756C9f3A542cc5ecEF78F83c8Ed6f48c241Be4'
  }
} as const;

