import { controller } from '../../pages/club-content/controller';
import { referenceComponent } from '../../services/reference-controller';

Component(referenceComponent(controller, {
  isBusy: data => !!data.busy,
  isDirty: data => !!data.editorDirty || !!data.inquiryContact?.trim() || !!data.inquiryMessage?.trim() || Object.values(data.replies || {}).some(value => typeof value === 'string' && !!value.trim()),
}));
