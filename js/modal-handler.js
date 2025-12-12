function createModalHandler(appDeps) {
    const { mainCanvas, toPx, toUnit, showModal, closeCallback, ref, watch, nextTick } = appDeps;

    // Modal State (Graph Based)
    const modalCanvas = ref(null);
    const modalSelectedObject = ref(null);
    const modalSelectedType = ref(null);
    const edgeProps = ref({ length: 0, angle: 0 });
    const autoFill = ref(true);
    const modalGridSize = ref(50);

    // Graph Data
    let vertices = [];
    let edges = [];
    let fillObject = null;

    // Helper Constants
    const SNAP_DIST = 10;

    // --- Modal Interactivity State & Handlers ---
    let isModalDragging = false, isModalSpacePressed = false, lastMX = 0, lastMY = 0;

    const modalKeyDownHandler = (e) => {
        if (e.code === 'Space' && !isModalSpacePressed) {
            e.preventDefault();
            isModalSpacePressed = true;
            if (modalCanvas.value) {
                modalCanvas.value.defaultCursor = 'grab';
                modalCanvas.value.selection = false;
                modalCanvas.value.requestRenderAll();
            }
        }
    };
    const modalKeyUpHandler = (e) => {
        if (e.code === 'Space') {
            e.preventDefault();
            isModalSpacePressed = false;
            if (modalCanvas.value && !isModalDragging) {
                modalCanvas.value.defaultCursor = 'default';
                modalCanvas.value.selection = true;
                modalCanvas.value.requestRenderAll();
            }
        }
    };

    const drawModalGrid = (size) => {
        if (!modalCanvas.value || typeof size !== 'number' || !isFinite(size) || size <= 0) {
            return;
        }
        const existingLines = modalCanvas.value.getObjects('line').filter(l => l.isGridLine);
        existingLines.forEach(l => modalCanvas.value.remove(l));
        const gridLineOpts = { stroke: '#333', selectable: false, evented: false, isGridLine: true };
        const newLines = [];
        const boundary = 2000;
        for (let i = -boundary; i <= boundary; i += size) {
            newLines.push(new fabric.Line([i, -boundary, i, boundary], gridLineOpts));
            newLines.push(new fabric.Line([-boundary, i, boundary, i], gridLineOpts));
        }
        newLines.forEach(line => {
            modalCanvas.value.add(line);
            line.sendToBack();
        });
        modalCanvas.value.requestRenderAll();
    };

    watch(modalGridSize, (newSize) => {
        if (showModal.value) drawModalGrid(newSize);
    });

    const init = () => {
        vertices = []; edges = []; fillObject = null;

        const wrapper = document.getElementById('modal-canvas-wrapper');
        modalCanvas.value = new fabric.Canvas('modal-canvas', {
            width: wrapper.clientWidth, height: wrapper.clientHeight,
            backgroundColor: '#252526',
            selection: true
        });

        drawModalGrid(modalGridSize.value);

        window.addEventListener('keydown', modalKeyDownHandler);
        window.addEventListener('keyup', modalKeyUpHandler);

        modalCanvas.value.on('mouse:down', function (opt) {
            const evt = opt.e;
            if (isModalSpacePressed && evt.button === 0) {
                isModalDragging = true;
                this.selection = false;
                lastMX = evt.clientX;
                lastMY = evt.clientY;
                this.defaultCursor = 'grabbing';
            }
        });
        modalCanvas.value.on('mouse:move', function (opt) {
            if (isModalDragging) {
                const e = opt.e;
                const vpt = this.viewportTransform;
                vpt[4] += e.clientX - lastMX;
                vpt[5] += e.clientY - lastMY;
                this.requestRenderAll();
                lastMX = e.clientX;
                lastMY = e.clientY;
            }
        });
        modalCanvas.value.on('mouse:up', function () {
            this.setViewportTransform(this.viewportTransform);
            isModalDragging = false;
            if (!isModalSpacePressed) {
                this.selection = true;
            }
            this.defaultCursor = isModalSpacePressed ? 'grab' : 'default';
            this.requestRenderAll();
        });

        modalCanvas.value.on('mouse:wheel', function (opt) {
            const evt = opt.e;
            evt.preventDefault(); evt.stopPropagation();
            const delta = evt.deltaY;

            if (evt.altKey) {
                let zoom = this.getZoom() * (0.999 ** delta);
                if (zoom > 5) zoom = 5; if (zoom < 0.2) zoom = 0.2;
                this.zoomToPoint({ x: evt.offsetX, y: evt.offsetY }, zoom);
            } else {
                const speedMultiplier = evt.shiftKey ? 5 : 1;
                const moveAmount = delta * speedMultiplier;
                const vpt = this.viewportTransform;
                if (evt.ctrlKey) {
                    vpt[4] -= moveAmount;
                } else {
                    vpt[5] -= moveAmount;
                }
                this.requestRenderAll();
            }
        });

        modalCanvas.value.on('object:moving', (e) => {
            const target = e.target;

            if (target.type === 'circle') {
                handleVertexDrag(target);
            } else if (target.type === 'line' && target.v1 && target.v2) {
                const line = target;
                const transform = e.transform;
                if (!transform) return;

                const newCenter = transform.target.getCenterPoint();
                const originalCenter = new fabric.Point(transform.original.left, transform.original.top);
                const dx = newCenter.x - originalCenter.x;
                const dy = newCenter.y - originalCenter.y;
                
                // Store initial positions on first move
                if (!line.__initialMove) {
                    line.__initialMove = true;
                    line.v1.__originalLeft = line.v1.left;
                    line.v1.__originalTop = line.v1.top;
                    line.v2.__originalLeft = line.v2.left;
                    line.v2.__originalTop = line.v2.top;
                }

                const grid = modalGridSize.value;

                // Move vertices
                line.v1.set({
                    left: Math.round((line.v1.__originalLeft + dx) / grid) * grid,
                    top: Math.round((line.v1.__originalTop + dy) / grid) * grid
                });

                line.v2.set({
                    left: Math.round((line.v2.__originalLeft + dx) / grid) * grid,
                    top: Math.round((line.v2.__originalTop + dy) / grid) * grid
                });

                updateConnectedEdges(line.v1);
                updateConnectedEdges(line.v2);
                
                detectAndFillLoops();
                modalCanvas.value.requestRenderAll();
            }
        });

        modalCanvas.value.on('object:modified', (e) => {
            const target = e.target;
            if (target.type === 'circle') {
                handleVertexDrop(e.target);
            } else if (target.type === 'line') {
                delete target._v1_original_selection;
                delete target._v2_original_selection;
            }
        });

        modalCanvas.value.on('selection:created', onModalSelection);
        modalCanvas.value.on('selection:updated', onModalSelection);
        modalCanvas.value.on('selection:cleared', () => {
            if (modalSelectedObject.value && modalSelectedObject.value.type === 'line') {
                delete modalSelectedObject.value._v1_original_selection;
                delete modalSelectedObject.value._v2_original_selection;
            }
            modalSelectedObject.value = null; modalSelectedType.value = null;
        });
    };

    const dispose = () => {
        window.removeEventListener('keydown', modalKeyDownHandler);
        window.removeEventListener('keyup', modalKeyUpHandler);
        isModalSpacePressed = false;
        isModalDragging = false;
        if (modalCanvas.value) {
            modalCanvas.value.dispose();
            modalCanvas.value = null;
        }
    };

    const onModalSelection = (e) => {
        if (e.selected && e.selected.length > 1) {
            modalCanvas.value.discardActiveObject();
            modalCanvas.value.renderAll();
            return;
        }
        const target = e.target || (e.selected && e.selected.length ? e.selected[0] : null);

        if (!target) {
            modalSelectedObject.value = null; 
            modalSelectedType.value = null;
            return;
        }
        
        modalSelectedObject.value = target;
        if (target.type === 'circle') {
            modalSelectedType.value = 'vertex';
        } else if (target.type === 'line' && target.v1 && target.v2) {
            modalSelectedType.value = 'edge';
            calculateEdgeProps(target);
            // NEW: Store original vertex positions on selection
            target._v1_original_selection = { left: target.v1.left, top: target.v1.top };
            target._v2_original_selection = { left: target.v2.left, top: target.v2.top };
        } else {
            modalSelectedObject.value = null;
            modalSelectedType.value = null;
        }
    };

    const handleVertexDrag = (vertex) => {
        const grid = modalGridSize.value;
        vertex.set({
            left: Math.round(vertex.left / grid) * grid,
            top: Math.round(vertex.top / grid) * grid
        });
        updateConnectedEdges(vertex);

        vertex.set('fill', '#e74c3c');
        vertex.snapTarget = null;

        for (let v of vertices) {
            if (v === vertex) continue;
            const dist = Math.hypot(v.left - vertex.left, v.top - vertex.top);
            if (dist < SNAP_DIST) {
                vertex.left = v.left;
                vertex.top = v.top;
                vertex.set('fill', '#2ecc71');
                vertex.snapTarget = v;
                break;
            }
        }

        updateConnectedEdges(vertex);
        detectAndFillLoops();
    };

    const handleVertexDrop = (vertex) => {
        if (vertex.snapTarget) {
            mergeVertices(vertex, vertex.snapTarget);
        } else {
            detectAndFillLoops();
        }
    };

    const mergeVertices = (sourceV, targetV) => {
        edges.forEach(e => {
            if (e.v1 === sourceV) e.v1 = targetV;
            if (e.v2 === sourceV) e.v2 = targetV;
        });

        modalCanvas.value.remove(sourceV);
        vertices = vertices.filter(v => v !== sourceV);

        edges = edges.filter(e => {
            if (e.v1 === e.v2) {
                modalCanvas.value.remove(e);
                return false;
            }
            return true;
        });

        updateConnectedEdges(targetV);

        if (modalSelectedObject.value === sourceV) {
            modalCanvas.value.setActiveObject(targetV);
            onModalSelection({ selected: [targetV] });
        }

        detectAndFillLoops();
        modalCanvas.value.requestRenderAll();
    };

    const detectAndFillLoops = () => {
        if (!autoFill.value) {
            if (fillObject) {
                modalCanvas.value.remove(fillObject);
                fillObject = null;
            }
            return;
        }
        if (fillObject) {
            modalCanvas.value.remove(fillObject);
            fillObject = null;
        }
        if (vertices.length < 3) {
            return;
        }

        const adj = new Map();
        vertices.forEach(v => { if (v) adj.set(v.id, []); });
        edges.forEach(e => {
            if (e.v1 && e.v2 && adj.has(e.v1.id) && adj.has(e.v2.id)) {
                adj.get(e.v1.id).push(e.v2.id);
                adj.get(e.v2.id).push(e.v1.id);
            }
        });

        const visited = new Set();
        const path = [];
        let cycleFound = null;

        const findCycle = (currId, parentId) => {
            visited.add(currId);
            path.push(currId);

            const neighbors = adj.get(currId);
            if (!neighbors) return false;

            for (let neighborId of neighbors) {
                if (neighborId === parentId) continue;
                if (visited.has(neighborId)) {
                    const startIndex = path.indexOf(neighborId);
                    if (startIndex !== -1) {
                        cycleFound = path.slice(startIndex);
                        return true;
                    }
                } else {
                    if (findCycle(neighborId, currId)) return true;
                }
            }
            path.pop();
            return false;
        };

        for (let v of vertices) {
            if (v && !visited.has(v.id)) {
                if (findCycle(v.id, null)) break;
            }
        }

        if (cycleFound && cycleFound.length >= 3) {
            const cycleVertices = cycleFound.map(id => vertices.find(vx => vx.id === id));
            const points = cycleVertices.map(v => ({ x: v.left, y: v.top }));
            
            fillObject = new fabric.Polygon(points, {
                fill: 'rgba(52, 152, 219, 0.3)',
                selectable: false, evented: false, isFillObject: true
            });
            fillObject.cycle = cycleVertices; // Store the vertices for real-time updates

            modalCanvas.value.add(fillObject);
            fillObject.sendToBack();

            modalCanvas.value.getObjects('line').forEach(o => {
                if (o.isGridLine) o.sendToBack();
            });
        }
    };

    const createVertex = (x, y) => {
        const c = new fabric.Circle({
            left: x, top: y, radius: 6,
            fill: '#e74c3c', stroke: 'white', strokeWidth: 2,
            originX: 'center', originY: 'center',
            hasControls: false, hasBorders: false
        });
        c.id = Date.now() + Math.random();
        modalCanvas.value.add(c);
        vertices.push(c);
        return c;
    };

    const createEdge = (v1, v2) => {
        const line = new fabric.Line([v1.left, v1.top, v2.left, v2.top], {
            stroke: '#f1c40f', strokeWidth: 4,
            selectable: true, hasControls: false, hasBorders: true,
            originX: 'center', originY: 'center',
        });
        line.v1 = v1;
        line.v2 = v2;
        modalCanvas.value.add(line);
        line.sendToBack();
        edges.push(line);
        return line;
    };

    const updateConnectedEdges = (vertex) => {
        edges.forEach(edge => {
            if (!edge.v1 || !edge.v2) return;
            if (edge.v1 === vertex) {
                edge.set({ x1: vertex.left, y1: vertex.top });
            }
            else if (edge.v2 === vertex) {
                edge.set({ x2: vertex.left, y2: vertex.top });
            }
            edge.setCoords();
        });
        if (modalSelectedObject.value && modalSelectedType.value === 'edge' && (modalSelectedObject.value.v1 === vertex || modalSelectedObject.value.v2 === vertex)) {
            calculateEdgeProps(modalSelectedObject.value);
        }
    };

    const onVertexInput = (axis, value) => {
        const v = modalSelectedObject.value;
        if (!v || v.type !== 'circle') return;

        const pxValue = toPx(value);
        if (axis === 'x') v.set('left', pxValue);
        else v.set('top', pxValue);

        v.setCoords();
        updateConnectedEdges(v);
        detectAndFillLoops();
        modalCanvas.value.requestRenderAll();
    };

    const calculateEdgeProps = (line) => {
        if (!line.v1 || !line.v2) {
            const dx = line.x2 - line.x1;
            const dy = line.y2 - line.y1;
            edgeProps.value.length = toUnit(Math.sqrt(dx * dx + dy * dy));
            edgeProps.value.angle = parseFloat((Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2));
            return;
        };
        const dx = line.v2.left - line.v1.left;
        const dy = line.v2.top - line.v1.top;
        edgeProps.value.length = toUnit(Math.sqrt(dx * dx + dy * dy));
        edgeProps.value.angle = parseFloat((Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2));
    };

    const updateEdgeFromParam = (type) => {
        const line = modalSelectedObject.value;
        if (!line || !line.v1 || !line.v2) return;

        if (type === 'length') {
            const len = toPx(edgeProps.value.length);
            const curAng = Math.atan2(line.y2 - line.y1, line.x2 - line.x1);
            line.v2.left = line.v1.left + len * Math.cos(curAng);
            line.v2.top = line.v1.top + len * Math.sin(curAng);
        } else if (type === 'angle') {
            const ang = edgeProps.value.angle * Math.PI / 180;
            const dx = line.x2 - line.x1;
            const dy = line.y2 - line.y1;
            const curLen = Math.sqrt(dx * dx + dy * dy);
            line.v2.left = line.v1.left + curLen * Math.cos(ang);
            line.v2.top = line.v1.top + curLen * Math.sin(ang);
        }

        line.v2.setCoords();
        updateConnectedEdges(line.v2);
        detectAndFillLoops();
        calculateEdgeProps(line);
        modalCanvas.value.requestRenderAll();
    };

    const addModalLine = () => {
        const v1 = createVertex(100, 100);
        const v2 = createVertex(200, 200);
        createEdge(v1, v2);
        detectAndFillLoops();
    };

    const addModalRectGraph = () => {
        const v1 = createVertex(150, 150);
        const v2 = createVertex(350, 150);
        const v3 = createVertex(350, 300);
        const v4 = createVertex(150, 300);
        createEdge(v1, v2); createEdge(v2, v3); createEdge(v3, v4); createEdge(v4, v1);
        detectAndFillLoops();
    };

    const addModalPolygonGraph = () => {
        const sides = 5, radius = 80, cx = 300, cy = 200;
        const newVerts = [];
        for (let i = 0; i < sides; i++) {
            const ang = (i * 2 * Math.PI / sides) - Math.PI / 2;
            newVerts.push(createVertex(cx + radius * Math.cos(ang), cy + radius * Math.sin(ang)));
        }
        for (let i = 0; i < sides; i++) createEdge(newVerts[i], newVerts[(i + 1) % sides]);
        detectAndFillLoops();
    };

    const saveModel = () => {
        if (edges.length === 0) return;
        const objects = [];
        if (fillObject) objects.push(new fabric.Polygon(fillObject.points, { fill: 'rgba(52, 152, 219, 0.5)' }));
        edges.forEach(e => objects.push(new fabric.Line([e.x1, e.y1, e.x2, e.y2], { stroke: '#f1c40f', strokeWidth: 2 })));
        vertices.forEach(v => objects.push(new fabric.Circle({ left: v.left, top: v.top, radius: 3, fill: '#e74c3c', originX: 'center', originY: 'center' })));

        const group = new fabric.Group(objects, { left: 100, top: 100 });
        mainCanvas.value.add(group);
        mainCanvas.value.setActiveObject(group);
        mainCanvas.value.requestRenderAll();
        closeCallback();
    };

    return {
        init,
        dispose,
        modalSelectedObject,
        modalSelectedType,
        edgeProps,
        autoFill,
        modalGridSize,
        onVertexInput,
        updateEdgeFromParam,
        addModalLine,
        addModalRectGraph,
        addModalPolygonGraph,
        saveModel,
        detectAndFillLoops
    };
}
