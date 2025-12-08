import * as THREE from 'three';

export class Player {
    constructor(scene, isRemote = false) {
        this.scene = scene;
        this.isRemote = isRemote;
        this.position = new THREE.Vector3(0, 100, 0); 
        this.rotation = 0;

        // Keys only needed for local player
        if (!isRemote) {
            this.keys = { w: false, a: false, s: false, d: false, space: false, shift: false };
            this.initInput();
        }

        this.mesh = this.createStickFigure();
        this.scene.add(this.mesh);

        this.walkSpeed = 15.0;
        this.swimSpeed = 8.0;
        this.animTime = 0;

        this.waterLevel = -2;
        this.heightOffset = 0.2; // Offset to keep feet on ground
        
        // Remote data interpolation
        this.targetPos = new THREE.Vector3();
        this.targetRot = 0;
        this.targetAction = 'idle';
    }

    initInput() {
        document.addEventListener('keydown', (e) => this.onKey(e, true));
        document.addEventListener('keyup', (e) => this.onKey(e, false));
    }

    onKey(e, pressed) {
        if (this.isRemote) return;
        const key = e.code.toLowerCase(); 
        // Support both WASD and Arrow keys
        if (key === 'keyw' || key === 'arrowup') this.keys.w = pressed;
        if (key === 'keya' || key === 'arrowleft') this.keys.a = pressed;
        if (key === 'keys' || key === 'arrowdown') this.keys.s = pressed;
        if (key === 'keyd' || key === 'arrowright') this.keys.d = pressed;
        if (key === 'space') this.keys.space = pressed;
        if (key === 'shiftleft' || key === 'shiftright') this.keys.shift = pressed;
    }

    createStickFigure() {
        const group = new THREE.Group();
        group.rotation.order = 'YXZ'; 
        group.castShadow = true;

        const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
        const jointMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5 }); 

        // 1. Container for body parts that can be tilted independently of the root Y-axis rotation
        this.bodyGroup = new THREE.Group();
        group.add(this.bodyGroup);

        // --- Torso ---
        // Slight taper for better shape
        const torsoGeo = new THREE.CapsuleGeometry(0.22, 0.7, 4, 8);
        this.torso = new THREE.Mesh(torsoGeo, mat);
        this.torso.position.y = 1.35;
        this.torso.castShadow = true;
        this.bodyGroup.add(this.torso);

        // --- Head ---
        this.head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), mat);
        this.head.position.y = 1.95;
        this.head.castShadow = true;
        this.bodyGroup.add(this.head);

        // --- Joint/Limb Factory ---
        const createSegment = (length, width = 0.11) => {
            const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(width, length, 4, 8), mat);
            // Center of capsule is (0,0,0), so we move it down by half length to rotate from top
            mesh.position.y = -length / 2; 
            mesh.castShadow = true;
            return mesh;
        };

        const createJoint = (x, y, z) => {
            const joint = new THREE.Group();
            joint.position.set(x, y, z);
            
            // Visual joint sphere
            const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), jointMat);
            sphere.castShadow = true;
            joint.add(sphere);
            
            return joint;
        };

        // --- Arms ---
        const armWidth = 0.09;
        const upperArmLen = 0.55;
        const lowerArmLen = 0.55;
        const shoulderY = 1.6;
        const shoulderX = 0.35;

        // Left Arm
        this.shoulderL = createJoint(-shoulderX, shoulderY, 0);
        this.upperArmL = createSegment(upperArmLen, armWidth);
        this.shoulderL.add(this.upperArmL);
        
        this.elbowL = createJoint(0, -upperArmLen, 0);
        this.upperArmL.add(this.elbowL); // Attach elbow to end of upper arm mesh? No, grouping is better.
        // Actually, upperArmL mesh is offset y. So (0, -len, 0) relative to shoulder is the elbow spot.
        // We need to structure it: Shoulder -> UpperArmGroup -> Elbow -> LowerArmGroup
        
        // Re-doing factory for hierarchy
        const buildLimb = (origin, upperLen, lowerLen, width) => {
            const root = new THREE.Group();
            root.position.copy(origin);

            const upperMesh = createSegment(upperLen, width);
            root.add(upperMesh);

            const joint = new THREE.Group();
            joint.position.y = -upperLen; // At end of upper
            root.add(joint);

            // Visual elbow/knee
            const jointSphere = new THREE.Mesh(new THREE.SphereGeometry(width * 1.2, 8, 8), jointMat);
            joint.add(jointSphere);

            const lowerMesh = createSegment(lowerLen, width * 0.9);
            joint.add(lowerMesh);
            
            return { root, joint, upperMesh, lowerMesh };
        };

        this.armL = buildLimb(new THREE.Vector3(-shoulderX, shoulderY, 0), upperArmLen, lowerArmLen, armWidth);
        this.armR = buildLimb(new THREE.Vector3(shoulderX, shoulderY, 0), upperArmLen, lowerArmLen, armWidth);
        
        this.bodyGroup.add(this.armL.root);
        this.bodyGroup.add(this.armR.root);

        // --- Legs ---
        const legWidth = 0.12;
        const upperLegLen = 0.65;
        const lowerLegLen = 0.65;
        const hipY = 1.0;
        const hipX = 0.2;

        this.legL = buildLimb(new THREE.Vector3(-hipX, hipY, 0), upperLegLen, lowerLegLen, legWidth);
        this.legR = buildLimb(new THREE.Vector3(hipX, hipY, 0), upperLegLen, lowerLegLen, legWidth);

        this.bodyGroup.add(this.legL.root);
        this.bodyGroup.add(this.legR.root);

        return group;
    }

    // For remote players to update their state
    updateRemote(dt, data) {
        if (!data) return;
        
        // Lerp position and rotation
        this.targetPos.set(data.x, data.y, data.z);
        this.targetRot = data.rot;
        
        this.position.lerp(this.targetPos, 10 * dt);
        
        // Handle rotation wrapping
        let rotDiff = this.targetRot - this.rotation;
        while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
        while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
        this.rotation += rotDiff * 10 * dt;
        
        this.mesh.position.copy(this.position);
        this.mesh.rotation.y = this.rotation;
        
        // Animation
        const isMoving = this.position.distanceTo(this.targetPos) > 0.1;
        // Determine swimming from y height relative to water roughly? 
        // Or pass 'isSwimming' in data. Assuming 'state' field in data for now.
        const isSwimming = data.state === 'swim';
        
        this.animateLimbs(dt, isMoving, isSwimming);
        
        // Pitch body based on move
        if (isSwimming) {
             // Simple pitch approx from vertical movement
             // Ideally this comes from network but we can infer
             const dy = this.targetPos.y - this.position.y;
             let targetPitch = Math.PI / 2;
             if (Math.abs(dy) > 0.01) targetPitch -= dy * 5.0;
             this.bodyGroup.rotation.x = THREE.MathUtils.lerp(this.bodyGroup.rotation.x, targetPitch, 5 * dt);
        } else {
             this.bodyGroup.rotation.x = THREE.MathUtils.lerp(this.bodyGroup.rotation.x, 0, 10 * dt);
             this.bodyGroup.position.y = 0;
        }
    }

    update(dt, getTerrainHeight, camera) {
        if (this.isRemote) return;

        const terrainHeight = getTerrainHeight(this.position.x, this.position.z);
        
        // Determine swimming
        const depth = this.waterLevel - terrainHeight;
        const isSwimming = (depth > 1.5) && (this.position.y < this.waterLevel + 0.5);
        const speed = isSwimming ? this.swimSpeed : this.walkSpeed;
        
        // Movement Input
        const moveDir = new THREE.Vector3(0, 0, 0);
        if (this.keys.w) moveDir.z -= 1;
        if (this.keys.s) moveDir.z += 1;
        if (this.keys.a) moveDir.x -= 1;
        if (this.keys.d) moveDir.x += 1;

        if (moveDir.length() > 0) {
            moveDir.normalize();
            
            // Relative to Camera
            const camEuler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
            moveDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), camEuler.y);
            
            // Rotate Player
            const targetRot = Math.atan2(moveDir.x, moveDir.z);
            let rotDiff = targetRot - this.rotation;
            while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
            while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
            this.rotation += rotDiff * 10 * dt;
        }

        // Apply Position
        this.position.x += moveDir.x * speed * dt;
        this.position.z += moveDir.z * speed * dt;
        
        if (isSwimming) {
             // Vertical Swim
             if (this.keys.space) this.position.y += speed * 0.5 * dt;
             if (this.keys.shift) this.position.y -= speed * 0.5 * dt;
             
             // Clamp
             if (this.position.y > this.waterLevel - 0.5) this.position.y = this.waterLevel - 0.5;
             if (this.position.y < terrainHeight + 1) this.position.y = terrainHeight + 1;
             
             // Body orientation for swimming (Horizontal)
             this.bodyGroup.rotation.x = THREE.MathUtils.lerp(this.bodyGroup.rotation.x, Math.PI / 2, 5 * dt);
        } else {
             // Walking
             this.position.y = terrainHeight + this.heightOffset;
             this.bodyGroup.rotation.x = THREE.MathUtils.lerp(this.bodyGroup.rotation.x, 0, 10 * dt);
        }
        
        this.bodyGroup.position.y = 0;

        this.mesh.position.copy(this.position);
        this.mesh.rotation.y = this.rotation;

        this.animateLimbs(dt, moveDir.length() > 0.1, isSwimming);
    }

    updateVR(dt, getTerrainHeight, dolly, controllers, input) {
        if (this.isRemote) return;

        const terrainHeight = getTerrainHeight(this.position.x, this.position.z);
        const waterHeight = this.waterLevel;
        
        // Determine swimming
        const depth = waterHeight - terrainHeight;
        const isSwimming = (depth > 1.5) && (this.position.y < waterHeight + 0.5);
        const speed = isSwimming ? this.swimSpeed : this.walkSpeed;
        
        // Rotation (Snap turn from input)
        this.rotation += input.rotate * dt;

        // Movement
        const moveDir = new THREE.Vector3();
        
        // Input is Vector2 (x, y) where y is forward (-1 usually)
        if (Math.abs(input.move.x) > 0.1 || Math.abs(input.move.y) > 0.1) {
            // Move relative to Player Rotation (which is synced with Camera Yaw roughly via snap turns)
            // In VR, "Forward" is usually where the head looks OR where the controller points.
            // Here we use the Player's body rotation for consistent WASD-like movement on stick.
            
            const fwd = -input.move.y;
            const right = input.move.x;
            
            const forwardVec = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.rotation);
            const rightVec = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.rotation);
            
            moveDir.addScaledVector(forwardVec, fwd);
            moveDir.addScaledVector(rightVec, right);
            moveDir.normalize();
        }

        // Apply Position
        this.position.x += moveDir.x * speed * dt;
        this.position.z += moveDir.z * speed * dt;
        
        // Height Logic
        if (isSwimming) {
             // Simple swim height clamping
             if (this.position.y < terrainHeight + 1) this.position.y = terrainHeight + 1;
             if (this.position.y > waterHeight - 0.5) this.position.y = waterHeight - 0.5;
             
             // Pitch body for swimming (based on moveDir dot forward?)
             if (moveDir.length() > 0.1) {
                this.bodyGroup.rotation.x = THREE.MathUtils.lerp(this.bodyGroup.rotation.x, Math.PI / 2, 5 * dt);
             } else {
                this.bodyGroup.rotation.x = THREE.MathUtils.lerp(this.bodyGroup.rotation.x, Math.PI / 4, 5 * dt);
             }
        } else {
             this.position.y = terrainHeight + this.heightOffset;
             this.bodyGroup.rotation.x = THREE.MathUtils.lerp(this.bodyGroup.rotation.x, 0, 10 * dt);
             this.bodyGroup.position.y = 0;
        }

        // Sync Mesh
        this.mesh.position.copy(this.position);
        this.mesh.rotation.y = this.rotation;

        // --- IK / Full Body Logic ---
        const isMoving = moveDir.length() > 0.1;
        
        // Hands IK
        let hasControllers = false;
        if (controllers && controllers.length >= 2) {
            hasControllers = true;
            if (controllers[0]) this.updateHandIK(controllers[0], this.armL);
            if (controllers[1]) this.updateHandIK(controllers[1], this.armR);
        }

        this.animateLimbs(dt, isMoving, isSwimming, hasControllers);
    }
    
    updateHandIK(controller, arm) {
        // Point arm at controller
        const targetPos = new THREE.Vector3();
        controller.getWorldPosition(targetPos);
        
        // Convert to local space of bodyGroup
        this.bodyGroup.worldToLocal(targetPos);
        
        const shoulderPos = arm.root.position.clone(); 
        const dir = new THREE.Vector3().subVectors(targetPos, shoulderPos);
        const dist = dir.length();
        
        // Simple Aim IK: Rotate shoulder to point at target
        // Arm default down (-Y). 
        const targetQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
        arm.root.quaternion.slerp(targetQuat, 0.5); // Smooth it
        
        // Reset elbow
        arm.joint.rotation.set(0,0,0);
        
        // If really close, maybe bend elbow? (Simple heuristic)
        if (dist < 0.8) {
             arm.joint.rotation.x = -1.5; // Fold arm
        }
    }

    animateLimbs(dt, isMoving, isSwimming, skipArms = false) {
        // Reset all joints
        // Helper to reset
        const reset = (limb) => {
            limb.root.rotation.set(0,0,0);
            limb.joint.rotation.set(0,0,0);
        }

        if (isSwimming) {
            if (isMoving) {
                // Freestyle / Flutter kick
                this.animTime += dt * 10;
                
                // Arms: Windmill / Crawl
                if (!skipArms) {
                    const armLPhase = this.animTime;
                    this.armL.root.rotation.x = Math.sin(armLPhase) * 2.5; 
                    this.armL.root.rotation.z = Math.abs(Math.sin(armLPhase)) * 0.5 + 0.2; 
                    this.armL.joint.rotation.x = -Math.max(0, Math.cos(armLPhase)) * 1.5; 

                    const armRPhase = this.animTime + Math.PI;
                    this.armR.root.rotation.x = Math.sin(armRPhase) * 2.5;
                    this.armR.root.rotation.z = -(Math.abs(Math.sin(armRPhase)) * 0.5 + 0.2);
                    this.armR.joint.rotation.x = -Math.max(0, Math.cos(armRPhase)) * 1.5;
                }

                // Legs: Flutter Kick (Quick, small amplitude)
                const legSpeed = this.animTime * 1.5;
                this.legL.root.rotation.x = Math.sin(legSpeed) * 0.5;
                this.legL.joint.rotation.x = Math.sin(legSpeed - 0.5) * 0.3 + 0.3; // Slight knee bend

                this.legR.root.rotation.x = Math.sin(legSpeed + Math.PI) * 0.5;
                this.legR.joint.rotation.x = Math.sin(legSpeed + Math.PI - 0.5) * 0.3 + 0.3;

            } else {
                // Treading Water (Vertical-ish)
                this.animTime += dt * 3;

                if (!skipArms) {
                    // Arms sculling
                    this.armL.root.rotation.x = 0.5; 
                    this.armL.root.rotation.z = 0.5 + Math.sin(this.animTime) * 0.3;
                    this.armL.joint.rotation.x = -0.5; 

                    this.armR.root.rotation.x = 0.5;
                    this.armR.root.rotation.z = -0.5 - Math.sin(this.animTime) * 0.3;
                    this.armR.joint.rotation.x = -0.5;
                }

                // Legs eggbeater (cycling)
                this.legL.root.rotation.x = Math.sin(this.animTime) * 0.5;
                this.legL.root.rotation.z = Math.cos(this.animTime) * 0.3;
                this.legL.joint.rotation.x = 1.0;

                this.legR.root.rotation.x = Math.sin(this.animTime + Math.PI) * 0.5;
                this.legR.root.rotation.z = Math.cos(this.animTime + Math.PI) * 0.3;
                this.legR.joint.rotation.x = 1.0;
            }
        } else if (isMoving) {
            // Walking
            this.animTime += dt * 10;

            if (!skipArms) {
                // Arms (Opposite to legs)
                this.armL.root.rotation.x = Math.cos(this.animTime) * 0.6;
                this.armL.root.rotation.z = 0.1;
                this.armL.joint.rotation.x = -0.4 - Math.sin(this.animTime) * 0.2; 

                this.armR.root.rotation.x = Math.cos(this.animTime + Math.PI) * 0.6;
                this.armR.root.rotation.z = -0.1;
                this.armR.joint.rotation.x = -0.4 - Math.sin(this.animTime + Math.PI) * 0.2;
            }

            // Legs
            // Hip
            this.legL.root.rotation.x = Math.sin(this.animTime) * 0.8;
            this.legR.root.rotation.x = Math.sin(this.animTime + Math.PI) * 0.8;
            
            // Knee (Only bends back when lifting)
            // If sin > 0 (leg moving forward), knee straight. If sin < 0 (leg moving back/up), knee bend.
            // Actually, in walk cycle:
            // Forward swing: Knee straight
            // Backward push: Knee straight
            // Recovery (passing under): Knee bent
            const kneeL = Math.sin(this.animTime - 1.5); 
            const kneeR = Math.sin(this.animTime + Math.PI - 1.5);
            
            this.legL.joint.rotation.x = kneeL > 0 ? kneeL * 1.5 : 0;
            this.legR.joint.rotation.x = kneeR > 0 ? kneeR * 1.5 : 0;

        } else {
            // Idle
            const s = Math.sin(Date.now() * 0.003);
            if (!skipArms) {
                this.armL.root.rotation.z = 0.1 + s * 0.02;
                this.armR.root.rotation.z = -0.1 - s * 0.02;
                this.armL.root.rotation.x = 0;
                this.armR.root.rotation.x = 0;
            }
            
            this.legL.root.rotation.set(0,0,0);
            this.legR.root.rotation.set(0,0,0);
            this.legL.joint.rotation.set(0,0,0);
            this.legR.joint.rotation.set(0,0,0);
            
            // Breathing
            this.torso.rotation.x = s * 0.05;
        }
    }

    getForward() {
        return this.rotation;
    }
}