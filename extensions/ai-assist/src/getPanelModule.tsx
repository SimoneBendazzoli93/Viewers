import React from 'react';
import { Types } from '@ohif/core';
import { PanelAIAssistant } from './Panels';

function getPanelModule({ commandsManager, extensionManager, servicesManager }): Types.Panel[] {
  return [
    {
      name: 'aiAssistant',
      iconName: 'tab-maia',
      iconLabel: 'AI',
      label: 'MAIA Radiology Assistant',
      component: props => (
        <PanelAIAssistant
          {...props}
          commandsManager={commandsManager}
          servicesManager={servicesManager}
        />
      ),
    },
  ];
}

export default getPanelModule;
