import { controller } from '../../pages/redemption/controller';
import { referenceComponent } from '../../services/reference-controller';

Component(referenceComponent(controller, {
  isBusy: data => !!data.busy,
  isDirty: data => !!(data.itemDirty || data.policyDirty || data.adminReason?.trim() || data.cancelReason?.trim()),
}));
