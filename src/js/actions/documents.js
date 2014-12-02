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

define(function (require, exports) {
    "use strict";

    var Promise = require("bluebird"),
        _ = require("lodash");

    var photoshopEvent = require("adapter/lib/photoshopEvent"),
        descriptor = require("adapter/ps/descriptor"),
        documentLib = require("adapter/lib/document"),
        layerLib = require("adapter/lib/layer"),
        ui = require("./ui"),
        events = require("../events"),
        locks = require("js/locks");

    /**
     * Get an array of layer descriptors for the given document descriptor.
     *
     * @private
     * @param {object} doc Document descriptor
     * @return {Promise.<Array.<object>>} Resolves with an array of layer descriptors
     */
    var _getLayersForDocument = function (doc) {
        var layerCount = doc.numberOfLayers,
            startIndex = (doc.hasBackgroundLayer ? 0 : 1),
            layerGets = _.range(layerCount, startIndex - 1, -1).map(function (i) {
                var layerReference = [
                    documentLib.referenceBy.id(doc.documentID),
                    layerLib.referenceBy.index(i)
                ];
                return descriptor.get(layerReference);
            });
        
        return Promise.all(layerGets);
    };

    var createNewCommand = function () {
        var docSettings = {
            width: 480,
            height: 480,
            resolution: 300,
            fill: "white",
            depth: 8,
            colorMode: "RGBColor",
            profile: "none",
            pixelAspectRation: 1
        };

        return descriptor.playObject(documentLib.create(docSettings))
            .bind(this)
            .then(function (result) {
                this.transfer(allocateDocument, result.documentID);
            });
    };

    /**
     * Completely reset all document and layer state. This is a heavy operation
     * that should only be called in an emergency!
     * 
     * @private
     * @return {Promise}
     */
    var onResetCommand = function () {
        return descriptor.getProperty("application", "numberOfDocuments")
            .bind(this)
            .then(function (docCount) {
                var payload = {};
                if (docCount === 0) {
                    payload.selectedDocumentID = null;
                    payload.documents = [];
                    this.dispatch(events.documents.RESET_DOCUMENTS, payload);
                    return;
                }

                var openDocumentPromises = _.range(1, docCount + 1)
                    .map(function (index) {
                        var indexRef = documentLib.referenceBy.index(index);
                        return descriptor.get(indexRef)
                            .then(function (doc) {
                                return _getLayersForDocument(doc)
                                    .bind(this)
                                    .then(function (layers) {
                                        return {
                                            document: doc,
                                            layers: layers
                                        };
                                    });
                            });
                    }),
                    openDocumentsPromise = Promise.all(openDocumentPromises);
                
                var currentRef = documentLib.referenceBy.current,
                    currentDocumentIDPromise = descriptor.getProperty(currentRef, "documentID");
                
                return Promise.join(currentDocumentIDPromise, openDocumentsPromise,
                    function (currentDocumentID, openDocuments) {
                        payload.selectedDocumentID = currentDocumentID;
                        payload.documents = openDocuments;
                        this.dispatch(events.documents.RESET_DOCUMENTS, payload);
                    }.bind(this));
            });
    };

    /**
     * Initialize document and layer state, emitting DOCUMENT_UPDATED and
     * CURRENT_DOCUMENT_UPDATED events for the open documents. This is different
     * from resetDocumentsCommand in two ways: 1) the emitted events are interpreted
     * by the stores as being additive (i.e., each new DOCUMENT_UPDATED event is
     * treated as indication that there is another document open); 2) these events
     * are emitted individually, and in particular the event for the current document
     * is emitted first. This is a performance optimization to allow the UI to be
     * rendered for the active document before continuing to build models for the
     * other documents.
     * 
     * @return {Promise}
     */
    var initDocumentsCommand = function () {
        return descriptor.getProperty("application", "numberOfDocuments")
            .bind(this)
            .then(function (docCount) {
                if (docCount === 0) {
                    return;
                }

                var currentRef = documentLib.referenceBy.current;
                return descriptor.get(currentRef)
                    .bind(this)
                    .then(function (currentDoc) {
                        var currentDocLayersPromise = _getLayersForDocument(currentDoc)
                            .bind(this)
                            .then(function (layers) {
                                var payload = {
                                    document: currentDoc,
                                    layers: layers
                                };

                                this.dispatch(events.documents.CURRENT_DOCUMENT_UPDATED, payload);
                            });

                        var otherDocPromises = _.range(1, docCount + 1)
                            .filter(function (index) {
                                return index !== currentDoc.itemIndex;
                            })
                            .map(function (index) {
                                var indexRef = documentLib.referenceBy.index(index);
                                return descriptor.get(indexRef)
                                    .bind(this)
                                    .then(function (doc) {
                                        return _getLayersForDocument(doc)
                                            .bind(this)
                                            .then(function (layers) {
                                                var payload = {
                                                    document: doc,
                                                    layers: layers
                                                };

                                                this.dispatch(events.documents.DOCUMENT_UPDATED, payload);
                                            });
                                    });
                            }, this),
                            otherDocsPromise = Promise.all(otherDocPromises);

                        return Promise.join(currentDocLayersPromise, otherDocsPromise);
                    });
            });
    };

    /**
     * Fetch the ID of the currently selected document, or null if there is none.
     * 
     * @private
     * @return {Promise.<?number>}
     */
    var _getSelectedDocumentID = function () {
        var currentRef = documentLib.referenceBy.current;
        return descriptor.getProperty(currentRef, "documentID")
            .catch(function () {
                return null;
            });
    };

    /**
     * Dispose of a previously opened document.
     * 
     * @private
     * @param {!number} documentID
     * @return {Promise}
     */
    var disposeDocumentCommand = function (documentID) {
        var disposePromise = _getSelectedDocumentID()
            .bind(this)
            .then(function (currentDocumentID) {
                var payload = {
                    documentID: documentID,
                    selectedDocumentID: currentDocumentID
                };

                this.dispatch(events.documents.CLOSE_DOCUMENT, payload);
            });

        var transformPromise = this.transfer(ui.updateTransform);

        return Promise.join(disposePromise, transformPromise);
    };

    /**
     * Allocate a newly opened document. Emits DOCUMENT_UPDATED and a SELECT_DOCUMENT
     * events.
     * 
     * @private
     * @param {!number} documentID
     * @return {Promise}
     */
    var allocateDocumentCommand = function (documentID) {
        var updatePromise = this.transfer(updateDocument, documentID),
            selectedDocumentPromise = _getSelectedDocumentID(),
            allocatePromise = Promise.join(selectedDocumentPromise, updatePromise,
                function (currentDocumentID) {
                    var payload = {
                        selectedDocumentID: currentDocumentID
                    };

                    this.dispatch(events.documents.SELECT_DOCUMENT, payload);
                }.bind(this));

        var transformPromise = this.transfer(ui.updateTransform);

        return Promise.join(allocatePromise, transformPromise);
    };

    /**
     * Update the document and layer state for the given document ID. Emits a
     * single DOCUMENT_UPDATED event.
     * 
     * @param {number} id Document ID
     * @return {Promise}
     */
    var updateDocumentCommand = function (id) {
        var docRef = documentLib.referenceBy.id(id);
        return descriptor.get(docRef)
            .bind(this)
            .then(function (doc) {
                return _getLayersForDocument(doc)
                    .bind(this)
                    .then(function (layerArray) {
                        var payload = {
                            document: doc,
                            layers: layerArray
                        };
                        this.dispatch(events.documents.DOCUMENT_UPDATED, payload);
                    });
            });
    };

    /**
     * Update the document and layer state for the currently active document ID.
     * Emits a single CURRENT_DOCUMENT_UPDATED event.
     * 
     * @return {Promise}
     */
    var updateCurrentDocumentCommand = function () {
        var currentRef = documentLib.referenceBy.current;
        return descriptor.get(currentRef)
            .bind(this)
            .then(function (doc) {
                return _getLayersForDocument(doc)
                    .bind(this)
                    .then(function (layers) {
                        var payload = {
                            document: doc,
                            layers: layers
                        };
                        this.dispatch(events.documents.CURRENT_DOCUMENT_UPDATED, payload);
                    });
            });
    };

    /**
     * Activate the given already-open document
     * 
     * @param {Document} document
     * @return {Promise}
     */
    var selectDocumentCommand = function (document) {
        return descriptor.playObject(documentLib.select(documentLib.referenceBy.id(document.id)))
            .bind(this)
            .then(function () {
                var payload = {
                    selectedDocumentID: document.id
                };
                
                this.dispatch(events.documents.SELECT_DOCUMENT, payload);
            });
    };

    /**
     * Activate the next open document in the document index
     * 
     * @return {Promise}
     */
    var selectNextDocumentCommand = function () {
        var applicationStore = this.flux.store("application"),
            nextDocument = applicationStore.getNextDocument();

        if (!nextDocument) {
            return Promise.resolve();
        }

        return this.transfer(selectDocument, nextDocument);
    };

    /**
     * Activate the previous open document in the document index
     * 
     * @return {Promise}
     */
    var selectPreviousDocumentCommand = function () {
        var applicationStore = this.flux.store("application"),
            previousDocument = applicationStore.getPreviousDocument();

        if (!previousDocument) {
            return Promise.resolve();
        }

        return this.transfer(selectDocument, previousDocument);
    };

    /**
     * Register event listeners for active and open document change events, and
     * initialize the active and open document lists.
     * 
     * @return {Promise}
     */
    var onStartupCommand = function () {
        var applicationStore = this.flux.store("application");

        descriptor.addListener("make", function (event) {
            var target = photoshopEvent.targetOf(event),
                currentDocument;

            switch (target) {
            case "document":
                // A new document was created
                if (typeof event.documentID === "number") {
                    this.flux.actions.documents.allocateDocument(event.documentID);
                } else {
                    this.flux.actions.documents.resetDocuments();
                }
                
                break;
            case "layer":
            case "contentLayer":
            case "textLayer":
                // A layer was added
                currentDocument = applicationStore.getCurrentDocument();
                this.flux.actions.documents.updateDocument(currentDocument.id);
                break;
            }
        }.bind(this));

        descriptor.addListener("open", function (event) {
            // A new document was opened
            if (typeof event.documentID === "number") {
                this.flux.actions.documents.allocateDocument(event.documentID);
            } else {
                this.flux.actions.documents.resetDocuments();
            }
        }.bind(this));
        
        descriptor.addListener("close", function (event) {
            // An open document was closed
            if (typeof event.documentID === "number") {
                this.flux.actions.documents.disposeDocument(event.documentID);
            } else {
                this.flux.actions.documents.resetDocuments();
            }
        }.bind(this));

        descriptor.addListener("select", function (event) {
            var nextDocument,
                currentDocument;

            if (photoshopEvent.targetOf(event) === "document") {
                if (typeof event.documentID === "number") {
                    // FIXME: This event is incorrectly triggered even when the
                    // document selection is initiated internally. Ideally it
                    // would not be, and this would be unnecessary.
                    nextDocument = this.flux.store("document").getDocument(event.documentID);

                    if (nextDocument) {
                        currentDocument = applicationStore.getCurrentDocument();

                        if (currentDocument !== nextDocument) {
                            this.flux.actions.documents.selectDocument(nextDocument);
                        }
                    } else {
                        this.flux.actions.documents.resetDocuments();
                    }
                } else {
                    this.flux.actions.documents.resetDocuments();
                }
            }
        }.bind(this));

        // Overkill, but pasting a layer just gets us a simple paste event with no descriptor
        descriptor.addListener("paste", function () {
            this.flux.actions.documents.updateCurrentDocument();
        }.bind(this));
        
        return this.transfer(initDocuments);
    };

    var createNew = {
        command: createNewCommand,
        reads: [locks.PS_DOC, locks.PS_APP],
        writes: [locks.JS_DOC, locks.JS_APP]
    };

    var selectDocument = {
        command: selectDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var selectNextDocument = {
        command: selectNextDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var selectPreviousDocument = {
        command: selectPreviousDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var allocateDocument = {
        command: allocateDocumentCommand,
        reads: [locks.PS_DOC, locks.PS_APP],
        writes: [locks.JS_DOC, locks.JS_APP]
    };
    
    var disposeDocument = {
        command: disposeDocumentCommand,
        reads: [locks.PS_DOC, locks.PS_APP],
        writes: [locks.JS_DOC, locks.JS_APP]
    };

    var updateDocument = {
        command: updateDocumentCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    var updateCurrentDocument = {
        command: updateCurrentDocumentCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    var initDocuments = {
        command: initDocumentsCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    var onReset = {
        command: onResetCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC, locks.JS_APP]
    };

    var onStartup = {
        command: onStartupCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    exports.createNew = createNew;
    exports.selectDocument = selectDocument;
    exports.selectNextDocument = selectNextDocument;
    exports.selectPreviousDocument = selectPreviousDocument;
    exports.allocateDocument = allocateDocument;
    exports.disposeDocument = disposeDocument;
    exports.updateDocument = updateDocument;
    exports.updateCurrentDocument = updateCurrentDocument;
    exports.initDocuments = initDocuments;
    exports.onReset = onReset;
    exports.onStartup = onStartup;
});
