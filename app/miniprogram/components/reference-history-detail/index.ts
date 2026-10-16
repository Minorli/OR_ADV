import { controller } from '../../pages/history-detail/controller';
import { referenceComponent } from '../../services/reference-controller';

Component(referenceComponent(controller, {
  isBusy: data => !!data.busy,
  isDirty: data => !!data.dirty,
}));
