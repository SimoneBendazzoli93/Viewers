import { Types } from '@ohif/core';
import { id } from './id';
import getPanelModule from './getPanelModule';
import getCommandsModule from './getCommandsModule';

export * from './types';
export { AIAgentService, DEFAULT_LLM_MODELS } from './services/AIAgentService';
export { PanelAIAssistant } from './Panels';

const extension: Types.Extensions.Extension = {
  id,

  getPanelModule,
  getCommandsModule,
};

export default extension;
