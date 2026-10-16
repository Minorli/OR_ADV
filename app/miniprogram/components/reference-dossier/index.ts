import { controller } from '../../pages/dossier/controller';
import { referenceComponent } from '../../services/reference-controller';

Component(referenceComponent(controller, {
  isBusy: data => !!(data.saving || data.uploading),
  isDirty: data => !!(data.dirty || data.uploadTarget),
}));
