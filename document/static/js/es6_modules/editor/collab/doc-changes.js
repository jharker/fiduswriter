import {
    compare
} from "fast-json-patch"

import {
    sendableSteps,
    receiveTransaction
} from "prosemirror-collab"
import {
    Step
} from "prosemirror-transform"

import {
    docSchema
} from "../../schema/document"
import {
    getSelectionUpdate,
    removeCollaboratorSelection,
    updateCollaboratorSelection
} from "../statePlugins"

export class ModCollabDocChanges {
    constructor(mod) {
        mod.docChanges = this
        this.mod = mod

        this.unconfirmedDiffs = {}
        this.confirmStepsRequestCounter = 0
        this.awaitingDiffResponse = false
        this.receiving = false
        this.currentlyCheckingVersion = false
    }

    cancelCurrentlyCheckingVersion() {
        this.currentlyCheckingVersion = false
        window.clearTimeout(this.enableCheckVersion)
    }

    checkVersion() {
        this.mod.editor.mod.serverCommunications.send(() => {
            if (this.currentlyCheckingVersion | !this.mod.editor.docInfo
                .version) {
                return
            }
            this.currentlyCheckingVersion = true
            this.enableCheckVersion = window.setTimeout(
                () => {
                    this.currentlyCheckingVersion = false
                },
                1000
            )
            if (this.mod.editor.mod.serverCommunications.connected) {
                this.disableDiffSending()
            }
            return {
                type: 'check_version',
                v: this.mod.editor.docInfo.version
            }
        })
    }

    disableDiffSending() {
        this.awaitingDiffResponse = true
        // If no answer has been received from the server within 2 seconds,
        // check the version
        this.sendNextDiffTimer = window.setTimeout(
            () => {
                this.awaitingDiffResponse = false
                this.sendToCollaborators()
            },
            8000
        )
    }

    enableDiffSending() {
        window.clearTimeout(this.sendNextDiffTimer)
        this.awaitingDiffResponse = false
        this.sendToCollaborators()
    }

    sendToCollaborators() {
        // Handle either doc change and comment updates OR caret update. Priority
        // for doc change/comment update.
        this.mod.editor.mod.serverCommunications.send(() => {
            if (
                this.awaitingDiffResponse ||
                this.mod.editor.waitingForDocument ||
                this.receiving
            ) {
                return false
            } else if (
                sendableSteps(this.mod.editor.view.state) ||
                this.mod.editor.mod.comments.store.unsentEvents().length ||
                this.mod.editor.mod.db.bibDB.unsentEvents().length ||
                this.mod.editor.mod.db.imageDB.unsentEvents().length
            ) {
                this.disableDiffSending()
                let stepsToSend = sendableSteps(this.mod.editor.view
                        .state),
                    fnStepsToSend = sendableSteps(this.mod.editor.mod
                        .footnotes.fnEditor.view.state),
                    commentUpdates = this.mod.editor.mod.comments.store
                    .unsentEvents(),
                    bibliographyUpdates = this.mod.editor.mod.db.bibDB
                    .unsentEvents(),
                    imageUpdates = this.mod.editor.mod.db.imageDB.unsentEvents()

                if (!stepsToSend &&
                    !fnStepsToSend &&
                    !commentUpdates.length &&
                    !bibliographyUpdates.length &&
                    !imageUpdates.length
                ) {
                    // no diff. abandon operation
                    return
                }
                let rid = this.confirmStepsRequestCounter++,
                    unconfirmedDiff = {
                        type: 'diff',
                        v: this.mod.editor.docInfo.version,
                        rid
                    }

                unconfirmedDiff['cid'] = this.mod.editor.client_id

                if (stepsToSend) {
                    unconfirmedDiff['ds'] = stepsToSend.steps.map(
                        s => s.toJSON()
                    )
                    // We add a json diff in a format understandable by the
                    // server. If the version is zero, we need to send a diff
                    // starting from an empty document.
                    let confirmedJson = this.mod.editor.docInfo.version ?
                        this.mod.editor.docInfo.confirmedDoc.firstChild
                        .toJSON() : {}
                    unconfirmedDiff['jd'] = compare(
                        confirmedJson,
                        this.mod.editor.view.state.doc.firstChild
                        .toJSON()
                    )
                    //unconfirmedDiff['confirmed_json'] = confirmedJson
                    // In case the title changed, we also add a title field to
                    // update the title field instantly - important for the
                    // document overview page.
                    let title = this.mod.editor.view.state.doc.firstChild
                        .firstChild.textContent.slice(0, 255)

                    if (
                        title !== this.mod.editor.docInfo.confirmedDoc
                        .firstChild.firstChild.textContent.slice(0,
                            255)
                    ) {
                        unconfirmedDiff['ti'] = title
                    }
                }

                if (fnStepsToSend) {
                    // We add the client ID to every single step
                    unconfirmedDiff['fs'] = fnStepsToSend.steps.map(
                        s => s.toJSON()
                    )
                }
                if (commentUpdates.length) {
                    unconfirmedDiff["cu"] = commentUpdates
                }
                if (bibliographyUpdates.length) {
                    unconfirmedDiff["bu"] = bibliographyUpdates
                }
                if (imageUpdates.length) {
                    unconfirmedDiff["iu"] = imageUpdates
                }

                this.unconfirmedDiffs[rid] = Object.assign(
                    {doc: this.mod.editor.view.state.doc},
                    unconfirmedDiff
                )
                return unconfirmedDiff

            } else if (getSelectionUpdate(this.mod.editor.currentView.state)) {
                let currentView = this.mod.editor.currentView

                if (this.lastSelectionUpdateState === currentView.state) {
                    // Selection update has been sent for this state already. Skip
                    return false
                }
                this.lastSelectionUpdateState = currentView.state
                // Create a new caret as the current user
                let selectionUpdate = getSelectionUpdate(currentView.state)
                return {
                    type: 'selection_change',
                    id: this.mod.editor.user.id,
                    v: this.mod.editor.docInfo.version,
                    session_id: this.mod.editor.docInfo.session_id,
                    anchor: selectionUpdate.anchor,
                    head: selectionUpdate.head,
                    // Whether the selection is in the footnote or the main editor
                    editor: currentView === this.mod.editor.view ?
                        'main' : 'footnotes'
                }
            } else {
                return false
            }
        })

    }

    receiveSelectionChange(data) {
        let participant = this.mod.participants.find(par => par.id === data
                .id),
            transaction, fnTransaction
        if (!participant) {
            // participant is still unknown to us. Ignore
            return
        }
        if (data.editor === 'footnotes') {
            fnTransaction = updateCollaboratorSelection(
                this.mod.editor.mod.footnotes.fnEditor.view.state,
                participant,
                data
            )
            transaction = removeCollaboratorSelection(
                this.mod.editor.view.state,
                data
            )
        } else {
            transaction = updateCollaboratorSelection(
                this.mod.editor.view.state,
                participant,
                data
            )
            fnTransaction = removeCollaboratorSelection(
                this.mod.editor.mod.footnotes.fnEditor.view.state,
                data
            )
        }
        if (transaction) {
            this.mod.editor.view.dispatch(transaction)
        }
        if (fnTransaction) {
            this.mod.editor.mod.footnotes.fnEditor.view.dispatch(
                fnTransaction)
        }
    }

    receiveFromCollaborators(data) {
        this.mod.editor.docInfo.version++
            if (data["bu"]) { // bibliography updates
                this.mod.editor.mod.db.bibDB.receive(data["bu"])
            }
        if (data["iu"]) { // images updates
            this.mod.editor.mod.db.imageDB.receive(data["iu"])
        }
        if (data["cu"]) { // comment updates
            this.mod.editor.mod.comments.store.receive(data["cu"])
        }
        if (data["ds"]) { // document steps
            this.applyDiffs(data["ds"], data["cid"])
        }
        if (data["fs"]) { // footnote steps
            this.mod.editor.mod.footnotes.fnEditor.applyDiffs(data["fs"], data["cid"])
        }

        if (data.server_fix) {
            // Diff is a fix created by server due to missing diffs.
            if ('reject_request_id' in data) {
                delete this.unconfirmedDiffs[data.reject_request_id]
            }
            this.cancelCurrentlyCheckingVersion()

            // There may be unsent local changes. Send them now after .5 seconds,
            // in case collaborators want to send something first.
            this.enableDiffSending()
            window.setTimeout(() => this.sendToCollaborators(), 500)

        }
    }

    setConfirmedDoc(transaction) {
        // Find the latest version of the doc without any unconfirmed local changes
        let rebased = transaction.getMeta("rebased")
        this.mod.editor.docInfo.confirmedDoc = rebased > 0 ?
            transaction.docs[transaction.docs.length - rebased] :
            transaction.doc
    }

    confirmDiff(request_id) {
        let unconfirmedDiffs = this.unconfirmedDiffs[request_id]
        if (!unconfirmedDiffs) {
            return
        }
        this.mod.editor.docInfo.version++
        this.mod.editor.docInfo.confirmedDoc = unconfirmedDiffs["doc"]

        let sentSteps = unconfirmedDiffs["ds"] // document steps
        if (sentSteps) {
            let transaction = receiveTransaction(
                this.mod.editor.view.state,
                sentSteps,
                sentSteps.map(
                    step => this.mod.editor.client_id
                )
            )
            this.mod.editor.view.dispatch(transaction)
        }

        let sentFnSteps = unconfirmedDiffs["fs"] // footnote steps
        if (sentFnSteps) {
            this.mod.editor.mod.footnotes.fnEditor.view.dispatch(
                receiveTransaction(
                    this.mod.editor.mod.footnotes.fnEditor.view.state,
                    sentFnSteps,
                    sentFnSteps.map(
                        step => this.mod.editor.client_id
                    )
                )
            )
        }

        let sentComments = unconfirmedDiffs["cu"] // comment updates
        if (sentComments) {
            this.mod.editor.mod.comments.store.eventsSent(sentComments)
        }

        let sentBibliographyUpdates = unconfirmedDiffs["bu"] // bibliography updates
        if (sentBibliographyUpdates) {
            this.mod.editor.mod.db.bibDB.eventsSent(sentBibliographyUpdates)
        }

        let sentImageUpdates = unconfirmedDiffs["iu"] // image updates
        if (sentImageUpdates) {
            this.mod.editor.mod.db.imageDB.eventsSent(sentImageUpdates)
        }

        delete this.unconfirmedDiffs[request_id]
        this.enableDiffSending()
    }

    rejectDiff(request_id) {
        delete this.unconfirmedDiffs[request_id]
        this.enableDiffSending()
    }

    applyDiffs(diffs, cid) {
        this.receiving = true
        let steps = diffs.map(j => Step.fromJSON(docSchema, j))
        let clientIds = diffs.map(j => cid)
        let transaction = receiveTransaction(
            this.mod.editor.view.state,
            steps,
            clientIds
        )
        transaction.setMeta('remote', true)
        this.mod.editor.view.dispatch(transaction)
        this.setConfirmedDoc(transaction)
        this.receiving = false
        this.sendToCollaborators()
    }
}
