import * as _ from 'underscore';
import template from './dashboard.html';
import shareDashboardTemplate from './share-dashboard.html';

function DashboardCtrl($rootScope, $routeParams, $location, $timeout, $q, $uibModal,
  Title, AlertDialog, Dashboard, currentUser, clientConfig, Events) {
  this.isFullscreen = false;
  this.refreshRate = null;
  this.showPermissionsControl = clientConfig.showPermissionsControl;
  this.currentUser = currentUser;
  this.globalParameters = [];
  this.refreshRates = [
    { name: '10秒', rate: 10 },
    { name: '30秒', rate: 30 },
    { name: '1分钟', rate: 60 },
    { name: '5分钟', rate: 60 * 5 },
    { name: '10分钟', rate: 60 * 10 },
    { name: '30分钟', rate: 60 * 30 },
    { name: '1小时', rate: 60 * 60 },
  ];

  this.setRefreshRate = (rate) => {
    this.refreshRate = rate;
    if (rate !== null) {
      this.loadDashboard(true);
      this.autoRefresh();
    }
  };

  this.extractGlobalParameters = () => {
    let globalParams = {};
    this.dashboard.widgets.forEach(row =>
      row.forEach((widget) => {
        if (widget.getQuery()) {
          widget.getQuery().getParametersDefs().filter(p => p.global).forEach((param) => {
            const defaults = {};
            defaults[param.name] = _.create(Object.getPrototypeOf(param), param);
            defaults[param.name].locals = [];
            globalParams = _.defaults(globalParams, defaults);
            globalParams[param.name].locals.push(param);
          });
        }
      })
    );
    this.globalParameters = _.values(globalParams);
  };

  this.onGlobalParametersChange = () => {
    this.globalParameters.forEach((global) => {
      global.locals.forEach((local) => {
        local.value = global.value;
      });
    });
  };

  const renderDashboard = (dashboard, force) => {
    Title.set(dashboard.name);
    const promises = [];

    this.dashboard.widgets.forEach(row =>
       row.forEach((widget) => {
         if (widget.visualization) {
           const maxAge = force ? 0 : undefined;
           const queryResult = widget.getQuery().getQueryResult(maxAge);
           if (!_.isUndefined(queryResult)) {
             promises.push(queryResult.toPromise());
           }
         }
       })
    );

    this.extractGlobalParameters();

    $q.all(promises).then((queryResults) => {
      const filters = {};
      queryResults.forEach((queryResult) => {
        const queryFilters = queryResult.getFilters();
        queryFilters.forEach((queryFilter) => {
          const hasQueryStringValue = _.has($location.search(), queryFilter.name);

          if (!(hasQueryStringValue || dashboard.dashboard_filters_enabled)) {
            // If dashboard filters not enabled, or no query string value given,
            // skip filters linking.
            return;
          }

          if (hasQueryStringValue) {
            queryFilter.current = $location.search()[queryFilter.name];
          }

          if (!_.has(filters, queryFilter.name)) {
            const filter = _.extend({}, queryFilter);
            filters[filter.name] = filter;
            filters[filter.name].originFilters = [];
          }

          // TODO: merge values.
          filters[queryFilter.name].originFilters.push(queryFilter);
        });
      });

      this.filters = _.values(filters);
      this.filtersOnChange = (filter) => {
        _.each(filter.originFilters, (originFilter) => {
          originFilter.current = filter.current;
        });
      };
    });
  };

  this.loadDashboard = _.throttle((force) => {
    this.dashboard = Dashboard.get({ slug: $routeParams.dashboardSlug }, (dashboard) => {
      Events.record('view', 'dashboard', dashboard.id);
      renderDashboard(dashboard, force);
    }, () => {
        // error...
        // try again. we wrap loadDashboard with throttle so it doesn't happen too often.
        // we might want to consider exponential backoff and also move this as a general
        // solution in $http/$resource for all AJAX calls.
      this.loadDashboard();
    });
  }, 1000);

  this.loadDashboard();

  this.autoRefresh = () => {
    $timeout(() => {
      this.loadDashboard(true);
    }, this.refreshRate.rate * 1000
    ).then(() => this.autoRefresh());
  };

  this.archiveDashboard = () => {
    const archive = () => {
      Events.record('archive', 'dashboard', this.dashboard.id);
      this.dashboard.$delete(() => {
        $rootScope.$broadcast('reloadDashboards');
      });
    };

    const title = '存档仪表盘';
    const message = `您确定要存档仪表盘"${this.dashboard.name}"吗?`;
    const confirm = { class: 'btn-warning', title: '存档' };

    AlertDialog.open(title, message, confirm).then(archive);
  };

  this.showManagePermissionsModal = () => {
    $uibModal.open({
      component: 'permissionsEditor',
      resolve: {
        aclUrl: { url: `api/dashboards/${this.dashboard.id}/acl` },
      },
    });
  };

  this.editDashboard = () => {
    $uibModal.open({
      component: 'editDashboardDialog',
      resolve: {
        dashboard: () => this.dashboard,
      },
    }).result.then((dashboard) => { this.dashboard = dashboard; });
  };

  this.addWidget = () => {
    $uibModal.open({
      component: 'addWidgetDialog',
      resolve: {
        dashboard: () => this.dashboard,
      },
    }).result.then(() => this.extractGlobalParameters());
  };

  this.toggleFullscreen = () => {
    this.isFullscreen = !this.isFullscreen;
    document.querySelector('body').classList.toggle('headless');

    if (this.isFullscreen) {
      $location.search('fullscreen', true);
    } else {
      $location.search('fullscreen', null);
    }
  };

  this.togglePublished = () => {
    Events.record('toggle_published', 'dashboard', this.dashboard.id);
    this.dashboard.is_draft = !this.dashboard.is_draft;
    this.saveInProgress = true;
    Dashboard.save({
      slug: this.dashboard.id,
      name: this.dashboard.name,
      layout: JSON.stringify(this.dashboard.layout),
      is_draft: this.dashboard.is_draft,
    }, (dashboard) => {
      this.saveInProgress = false;
      this.dashboard.version = dashboard.version;
      $rootScope.$broadcast('reloadDashboards');
    });
  };

  if (_.has($location.search(), 'fullscreen')) {
    this.toggleFullscreen();
  }

  this.openShareForm = () => {
    $uibModal.open({
      component: 'shareDashboard',
      resolve: {
        dashboard: this.dashboard,
      },
    });
  };
}

const ShareDashboardComponent = {
  template: shareDashboardTemplate,
  bindings: {
    resolve: '<',
    close: '&',
    dismiss: '&',
  },
  controller($http) {
    'ngInject';

    this.dashboard = this.resolve.dashboard;

    this.toggleSharing = () => {
      const url = `api/dashboards/${this.dashboard.id}/share`;

      if (!this.dashboard.publicAccessEnabled) {
        // disable
        $http.delete(url).success(() => {
          this.dashboard.publicAccessEnabled = false;
          delete this.dashboard.public_url;
        }).error(() => {
          this.dashboard.publicAccessEnabled = true;
          // TODO: show message
        });
      } else {
        $http.post(url).success((data) => {
          this.dashboard.publicAccessEnabled = true;
          this.dashboard.public_url = data.public_url;
        }).error(() => {
          this.dashboard.publicAccessEnabled = false;
          // TODO: show message
        });
      }
    };
  },
};

export default function (ngModule) {
  ngModule.component('shareDashboard', ShareDashboardComponent);
  ngModule.component('dashboardPage', {
    template,
    controller: DashboardCtrl,
  });

  return {
    '/dashboard/:dashboardSlug': {
      template: '<dashboard-page></dashboard-page>',
      reloadOnSearch: false,
    },
  };
}
