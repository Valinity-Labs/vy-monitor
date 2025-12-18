import common from '../common';
import ValinityAcquisitionOfficer from './ValinityAcquisitionOfficer';
import ValinityAssetRegistry from './ValinityAssetRegistry';
import ValinityCapOfficer from './ValinityCapOfficer';
import ValinityLoanOfficer from './ValinityLoanOfficer';

export default {
  abis: {
    ...common.abis,
    ValinityAcquisitionOfficer,
    ValinityAssetRegistry,
    ValinityCapOfficer,
    ValinityLoanOfficer
  },
  registeredContractNames: [
    ...common.registeredContractNames
  ],
  addresses: {
    ...common.addresses,
    ValinityRegistrar: '0x57DC5c2911Ec03F73e5778A3066e61f50695C4D3',
    Comptroller: '0x8c86Bc7D11A5817357A8d897a0Cd636078b6D2D9'
  }
} as const;
