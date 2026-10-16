import { controller } from '../../pages/skills/controller';
import { referenceComponent } from '../../services/reference-controller';

Component(referenceComponent(controller, {
  isBusy: data => !!data.busy,
  isDirty: data => !!(data.assetId || data.referenceEditor || data.reviewReason?.trim()) || !!data.selected && data.note !== (data.selected.submission?.note || ''),
}));
