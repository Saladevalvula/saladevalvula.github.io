/* Compatibilidade de bindings globais para a camada CMMS V2.
 * O app legado já declara a maior parte das funções sobrescritas. Estas três
 * telas são novas na V2 e precisam existir como bindings antes do script
 * principal executar em strict mode.
 */
var renderOrdersView;
var renderWorkOrdersView;
var renderDashboardView;
