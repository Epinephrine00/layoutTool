const { createApp, ref, onMounted, computed, nextTick, watch } = Vue;

const UNIT_SYSTEMS = {
    mks:  { name: 'MKS (Meters)', label: 'm', step: 0.1, pixelsPerUnit: 100, defaultGrid: 0.5 },
    mmgs: { name: 'MMGS (Millimeters)', label: 'mm', step: 10, pixelsPerUnit: 1, defaultGrid: 500 },
    ips:  { name: 'IPS (Inches)', label: 'in', step: 1, pixelsPerUnit: 96, defaultGrid: 20 }
};

createApp({
    setup() {
        // Main Editor State
        const sidebarWidth = ref(300);
        const currentTab = ref('library');
        const canvas = ref(null);
        const selectedObject = ref(null);
        const currentUnitKey = ref('mks');
        const currentUnit = computed(() => UNIT_SYSTEMS[currentUnitKey.value]);
        const gridSize = ref(0.5);
        const zoomLevel = ref(1);
        const viewportTransform = ref([1, 0, 0, 1, 0, 0]);
        const snapEnabled = ref(true);
        const props = ref({ left: 0, top: 0, width: 0, angle: 0, fill: '#ffffff' });
        const layers = ref([
            { id: 'amr', name: 'AMR', color: '#e74c3c', visible: true },
            { id: 'main', name: 'Main Layout', color: '#3498db', visible: true },
            { id: 'bg', name: 'Background', color: '#9b59b6', visible: true }
        ]);
        const activeLayerId = ref('main');
        const showModal = ref(false);

        // Helpers
        const toUnit = (px) => {
            if (px === undefined || px === null) return 0;
            const val = px / currentUnit.value.pixelsPerUnit;
            return currentUnitKey.value === 'mmgs' ? Math.round(val) : parseFloat(val.toFixed(3));
        };
        const toPx = (unitVal) => {
            if (unitVal === undefined || unitVal === null) return 0;
            return Math.round(parseFloat(unitVal) * currentUnit.value.pixelsPerUnit);
        }

        // --- Modal Handler ---
        const modalHandler = createModalHandler({
            mainCanvas: canvas,
            toPx,
            toUnit,
            showModal,
            closeCallback: () => { showModal.value = false; },
            ref,
            watch,
            nextTick
        });

        watch(showModal, (isShown) => {
            if (isShown) {
                nextTick(() => modalHandler.init());
            } else {
                modalHandler.dispose();
            }
        });
        
        const openModelerModal = () => { showModal.value = true; };
        const closeModelerModal = () => { showModal.value = false; };

        onMounted(() => { initMainCanvas(); });

        const initMainCanvas = () => {
            canvas.value = new fabric.Canvas('c', {
                backgroundColor: 'transparent',
                width: window.innerWidth - sidebarWidth.value,
                height: window.innerHeight - 32,
                preserveObjectStacking: true,
                selection: true
            });
            
            const lineOpts = { strokeWidth: 2, selectable: false, evented: false, isOrigin: true };
            canvas.value.add(new fabric.Line([0, 0, 50, 0], { ...lineOpts, stroke: '#ff3333' }));
            canvas.value.add(new fabric.Line([0, 0, 0, 50], { ...lineOpts, stroke: '#33cc33' }));

            canvas.value.on('mouse:wheel', function(opt) {
                const evt = opt.e;
                const delta = evt.deltaY;

                evt.preventDefault();
                evt.stopPropagation();

                if (evt.altKey) {
                    let zoom = canvas.value.getZoom();
                    zoom *= 0.999 ** delta;
                    if (zoom > 20) zoom = 20;
                    if (zoom < 0.05) zoom = 0.05;
                    
                    canvas.value.zoomToPoint({ x: evt.offsetX, y: evt.offsetY }, zoom);
                    
                    zoomLevel.value = zoom;
                    viewportTransform.value = canvas.value.viewportTransform;
                } 
                else {
                    const speedMultiplier = evt.shiftKey ? 5 : 1; 
                    const moveAmount = delta * speedMultiplier;
                    const vpt = canvas.value.viewportTransform;
                    if (evt.ctrlKey) {
                        vpt[4] -= moveAmount; 
                    } else {
                        vpt[5] -= moveAmount; 
                    }
                    canvas.value.requestRenderAll();
                    viewportTransform.value = [...vpt];
                }
            });

            let isDragging = false;
            let lastPosX, lastPosY;
            let isSpacePressed = false; 

            window.addEventListener('keydown', (e) => {
                if (e.code === 'Space' && !isSpacePressed && !showModal.value) {
                    isSpacePressed = true;
                    canvas.value.defaultCursor = 'grab';
                    canvas.value.selection = false; 
                    canvas.value.requestRenderAll();
                }
            });

            window.addEventListener('keyup', (e) => {
                if (e.code === 'Space' && !showModal.value) {
                    isSpacePressed = false;
                    canvas.value.defaultCursor = 'default';
                    if (!isDragging) {
                        canvas.value.selection = true;
                    }
                    canvas.value.requestRenderAll();
                }
            });

            canvas.value.on('mouse:down', function(opt) {
                const evt = opt.e;
                if (isSpacePressed && evt.button === 0) {
                    isDragging = true;
                    this.selection = false;
                    lastPosX = evt.clientX;
                    lastPosY = evt.clientY;
                    this.defaultCursor = 'grabbing';
                }
            });

            canvas.value.on('mouse:move', function(opt) {
                if (isDragging) {
                    const e = opt.e;
                    const vpt = this.viewportTransform;
                    vpt[4] += e.clientX - lastPosX;
                    vpt[5] += e.clientY - lastPosY;
                    this.requestRenderAll();
                    lastPosX = e.clientX;
                    lastPosY = e.clientY;
                    viewportTransform.value = [...vpt];
                }
            });
            canvas.value.on('mouse:up', function() {
                this.setViewportTransform(this.viewportTransform);
                isDragging = false;
                if (!isSpacePressed) {
                   this.selection = true;
                }
                this.defaultCursor = isSpacePressed ? 'grab' : 'default';
                this.requestRenderAll();
            });

            canvas.value.on('object:moving', function(e) {
                if (!snapEnabled.value) return;
                
                const target = e.target;
                const grid = gridSize.value * currentUnit.value.pixelsPerUnit;

                target.set({
                    left: Math.round(target.left / grid) * grid,
                    top: Math.round(target.top / grid) * grid
                });
            });

            canvas.value.on('selection:created', updateState);
            canvas.value.on('selection:updated', updateState);
            canvas.value.on('selection:cleared', () => selectedObject.value = null);
            canvas.value.on('object:modified', updateState);
        };

        const changeUnitSystem = () => {
            gridSize.value = currentUnit.value.defaultGrid;
            canvas.value.requestRenderAll();
        };

        const gridStyle = computed(() => {
            const zoom = zoomLevel.value;
            const panX = viewportTransform.value[4];
            const panY = viewportTransform.value[5];
            const sizePx = gridSize.value * currentUnit.value.pixelsPerUnit * zoom; 
            return { backgroundSize: `${sizePx}px ${sizePx}px`, backgroundPosition: `${panX}px ${panY}px` };
        });
        
        const isResizing = ref(false);
        const startResize = () => { isResizing.value = true; };
        window.addEventListener('mousemove', (e) => { if (isResizing.value) sidebarWidth.value = Math.max(200, Math.min(600, window.innerWidth - e.clientX)); });
        window.addEventListener('mouseup', () => { if(isResizing.value) { isResizing.value = false; canvas.value.setDimensions({ width: window.innerWidth - sidebarWidth.value, height: window.innerHeight - 32 }); } });

        const updateState = () => {
            const activeObj = canvas.value.getActiveObject();
            if (activeObj && activeObj.type !== 'activeSelection') {
                selectedObject.value = activeObj;
                props.value = { left: activeObj.left, top: activeObj.top, width: (activeObj.width || 0) * activeObj.scaleX, angle: activeObj.angle };
                currentTab.value = 'inspector';
            } else { selectedObject.value = null; }
        };
        const updateProp = (key, val) => { props.value[key] = toPx(val); const o = canvas.value.getActiveObject(); if(o) { o.set(key, props.value[key]); canvas.value.requestRenderAll(); } };
        const updateObject = () => { const o = canvas.value.getActiveObject(); if(o) { o.set(props.value); canvas.value.requestRenderAll(); } };
        const setActiveLayer = (id) => activeLayerId.value = id;
        const toggleLayerVisibility = (id) => {};

        return {
            sidebarWidth, currentTab, layers, activeLayerId, selectedObject, props,
            gridSize, snapEnabled, zoomLevel, gridStyle, currentUnitKey, currentUnit, changeUnitSystem,
            startResize, updateProp, updateObject, setActiveLayer, toggleLayerVisibility, toUnit, toPx,
            showModal, openModelerModal, closeModelerModal, 
            ...modalHandler
        };
    }
}).mount('#app');