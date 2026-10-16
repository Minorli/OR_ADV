import { controller } from '../../pages/learning/controller';
import { referenceComponent } from '../../services/reference-controller';

Component(referenceComponent(controller, {
  isBusy: data => !!data.busy,
  isDirty: data => !!data.editor || data.selectedIndex >= 0 && !data.feedback,
}));
