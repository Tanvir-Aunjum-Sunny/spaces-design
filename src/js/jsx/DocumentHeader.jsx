/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

define(function (require, exports, module) {
    "use strict";

    var Promise = require("bluebird"),
        React = require("react"),
        Fluxxor = require("fluxxor"),
        FluxMixin = Fluxxor.FluxMixin(React),
        StoreWatchMixin = Fluxxor.StoreWatchMixin,
        Immutable = require("immutable");

    var os = require("adapter/os");

    var DocumentHeaderTab = require("jsx!js/jsx/DocumentHeaderTab"),
        Button = require("jsx!js/jsx/shared/Button"),
        SVGIcon = require("jsx!js/jsx/shared/SVGIcon"),
        strings = require("i18n!nls/strings"),
        synchronization = require("js/util/synchronization"),
        searchStore = require("js/stores/search"),
        exportStore = require("js/stores/export");

    var DocumentHeader = React.createClass({
        mixins: [FluxMixin, StoreWatchMixin("application", "document", "tool", "dialog")],

        getInitialState: function () {
            return {};
        },

        /**
         * Get the active document from flux and add it to the state.
         */
        getStateFromFlux: function () {
            var flux = this.getFlux(),
                dialogStore = flux.store("dialog"),
                dialogState = dialogStore.getState(),
                exportActive = dialogState.openDialogs.has(exportStore.EXPORT_DIALOG_ID),
                searchActive = dialogState.openDialogs.has(searchStore.SEARCH_BAR_DIALOG_ID),
                toolStore = flux.store("tool"),
                toolState = toolStore.getState(),
                applicationStore = flux.store("application"),
                applicationState = applicationStore.getState(),
                documentIDs = applicationState.documentIDs,
                document = applicationStore.getCurrentDocument(),
                count = applicationStore.getDocumentCount(),
                inactiveDocumentsInitialized = applicationState.inactiveDocumentsInitialized;

            return {
                document: document,
                documentIDs: documentIDs,
                count: count,
                maskModeActive: toolState.vectorMaskMode,
                searchActive: searchActive,
                exportActive: exportActive,
                inactiveDocumentsInitialized: inactiveDocumentsInitialized
            };
        },

        /**
         * Update the sizes of the panels.
         *
         * @private
         * @return {Promise}
         */
        _updatePanelSizes: function () {
            var node = React.findDOMNode(this.refs.tabContainer),
                headerHeight;

            if (node) {
                headerHeight = node.getBoundingClientRect().height;
            } else {
                headerHeight = 0;
            }

            return this.getFlux().actions.ui.updatePanelSizes({
                headerHeight: headerHeight
            });
        },

        /**
         * Debounced version of _updatePanelSizes
         *
         * @private
         */
        _updatePanelSizesDebounced: null,

        /** @ignore */
        _updateTabContainerScroll: function () {
            var currentTab = window.document.querySelector(".document-title__current");
            if (currentTab) {
                var container = React.findDOMNode(this.refs.tabContainer),
                    bounds = currentTab.getBoundingClientRect();

                if (bounds.left < 0) {
                    container.scrollLeft = 0;
                } else if (bounds.right > container.clientWidth) {
                    container.scrollLeft = bounds.right;
                }
            }
        },

        shouldComponentUpdate: function (nextProps, nextState) {
            // Don't re-render if we're just going temporarily inactive so that
            // the UI doesn't blink unnecessarily.
            if (this.props.active && !nextProps.active) {
                return false;
            }

            if (!nextState.inactiveDocumentsInitialized) {
                return false;
            }

            return this.state.inactiveDocumentsInitialized !== nextState.inactiveDocumentsInitialized ||
                this.state.count !== nextState.count ||
                this.state.headerWidth !== nextState.headerWidth ||
                this.state.searchActive !== nextState.searchActive ||
                this.state.exportActive !== nextState.exportActive ||
                this.state.maskModeActive !== nextState.maskModeActive ||
                !Immutable.is(this.state.documentIDs, nextState.documentIDs) ||
                !Immutable.is(this.state.document, nextState.document);
        },

        componentDidMount: function () {
            this._updateTabContainerScroll();

            this.setState({
                headerWidth: React.findDOMNode(this).clientWidth
            });

            this._updatePanelSizesDebounced = synchronization.debounce(this._updatePanelSizes, this, 500);
            os.addListener("displayConfigurationChanged", this._updatePanelSizesDebounced);
            this._updatePanelSizes();
            
            this._handleWindowResizeDebounced = synchronization.debounce(this._handleWindowResize, this, 500);
            window.addEventListener("resize", this._handleWindowResizeDebounced);
        },

        componentWillUnmount: function () {
            os.removeListener("displayConfigurationChanged", this._updatePanelSizesDebounced);
            window.removeEventListener("resize", this._handleWindowResizeDebounced);
        },

        componentDidUpdate: function () {
            this._updateTabContainerScroll();
        },

        /**
         * Update the state with the size of the header element on resize
         *
         * @private
         * @return {Promise}
         */
        _handleWindowResize: function () {
            return new Promise(function (resolve) {
                this.setState({
                    headerWidth: React.findDOMNode(this).clientWidth
                }, resolve);
            }.bind(this));
        },

        /**
         * Debounced version of _handleWindowResize
         *
         * @private
         * @type {function}
         */
        _handleWindowResizeDebounced: null,

        /** @ignore */
        _handleTabClick: function (documentID) {
            var selectedDoc = this.getFlux().store("document").getDocument(documentID);
            if (selectedDoc) {
                this.getFlux().actions.documents.selectDocument(selectedDoc);
            }
        },

        /**
         * Opens the export dialog 
         */
        _openExportPanel: function () {
            this.getFlux().actions.export.openExportPanel();
        },

        /**
         * Toggles search feature
         */
        _toggleSearch: function () {
            this.getFlux().actions.search.toggleSearchBar();
        },

        /**
         * Changes mask mode 
         */
        _changeMaskMode: function () {
            this.getFlux().actions.tools.changeVectorMaskMode(!this.state.maskModeActive);
        },

        render: function () {
            var documentStore = this.getFlux().store("document"),
                document = this.state.document,
                smallTab = this.state.headerWidth / this.state.documentIDs.size < 175;
            // Above: This number tunes when tabs should be shifted to small tabs

            var exportDisabled = !document || document.unsupported,
                maskDisabled = !document || document.unsupported ||
                    document.layers.selected.isEmpty();

            if (!maskDisabled) {
                var firstLayer = document.layers.selected.first();
                maskDisabled = maskDisabled ||
                    firstLayer.locked ||
                    firstLayer.kind === firstLayer.layerKinds.VECTOR ||
                    firstLayer.isBackground;
            }

            var documentTabs = this.state.documentIDs.map(function (docID) {
                var doc = documentStore.getDocument(docID);

                if (doc) {
                    return (
                        <DocumentHeaderTab
                            key={"docheader" + docID}
                            smallTab={smallTab}
                            name={doc.name}
                            dirty={doc.dirty}
                            unsupported={doc.unsupported}
                            onClick={this._handleTabClick.bind(this, docID)}
                            current={document && docID === document.id} />
                    );
                }
            }, this);

            return (
                <div className="document-container">
                    <div className="document-header" ref="tabContainer">
                            {documentTabs}
                    </div>
                    <div className="icon-header">
                        <div className="icon-header-buttons">
                            <Button
                                className="button-plus"
                                title={strings.TOOLTIPS.SEARCH}
                                onClick={this._toggleSearch}
                                active={this.state.searchActive}>
                                <SVGIcon
                                    CSSID="layer-search-app" />
                            </Button>
                            <Button
                                className="button-plus"
                                title={strings.TOOLTIPS.VECTOR_MASK_MODE}
                                onClick={this._changeMaskMode}
                                disabled={maskDisabled}
                                active={this.state.maskModeActive}>
                                <SVGIcon
                                    CSSID="tool-maskmode" />
                            </Button>
                            <Button
                                className="button-plus"
                                title={strings.TOOLTIPS.EXPORT_DIALOG}
                                disabled={exportDisabled}
                                active={this.state.exportActive}
                                onClick={this._openExportPanel}>
                                <SVGIcon
                                    CSSID="extract-all" />
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }
    });

    module.exports = DocumentHeader;
});
